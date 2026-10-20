// Authentication and authorisation.
//
// What this replaced: a self-contained JWT that was verified only
// cryptographically. Nothing consulted the database, so a banned player kept
// working access for the full 7-day token lifetime, there was no way to revoke
// a session, and no concept of roles at all - meaning every "requires auth"
// endpoint (including moderation) was reachable by any player who had ever
// logged in.
//
// How it works now:
//
//   issueSession()   mints a JWT carrying a jti, and records the session in the
//                    `sessions` table with only a hash of the token stored.
//   authenticateToken
//                    verifies the signature, then re-reads the session row on
//                    every request to confirm it is unrevoked, unexpired, and
//                    that the owning player still exists and is not banned.
//                    req.user therefore reflects live database state, not
//                    whatever the token said seven days ago.
//   requireAdmin     accepts the configured ADMIN_KEY (X-Admin-Key) or a
//                    player flagged is_moderator. This is the gate that stops
//                    any logged-in player from banning the server.

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { config } = require('./config');
const { safeEqual, randomToken } = require('./crypto');
const { db, run, get, all, transaction } = require('../database');

const TOKEN_ALGORITHM = 'HS256';

// Default moderation / admin flag on the session object.
const ROLE_PLAYER = 'player';
const ROLE_MODERATOR = 'moderator';

// ---------------------------------------------------------------------------
// Session issuance
// ---------------------------------------------------------------------------

/**
 * Create a durable session and mint the JWT that represents it.
 *
 * The raw token is returned to the client; only its SHA-256 digest is stored,
 * so a database leak does not hand out usable sessions.
 *
 * @param {object} player row from `players`
 * @param {import('express').Request} [req] used only for audit columns
 * @returns {Promise<{token:string,jti:string,expiresAt:number,player:object}>}
 */
async function issueSession(player, req) {
  const jti = randomToken(16);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + config.sessionLifetimeMs;

  const token = jwt.sign(
    {
      // Numeric id, as a number. Previously some code paths signed a uuid while
      // the row id was an autoincrement integer, so every later lookup by
      // `WHERE id = ?` missed.
      id: Number(player.id),
      username: player.username,
      jti
    },
    config.jwtSecret,
    { algorithm: TOKEN_ALGORITHM, expiresIn: Math.floor(config.sessionLifetimeMs / 1000) }
  );

  await run(
    `INSERT INTO sessions
       (jti, player_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jti,
      player.id,
      hashToken(token),
      issuedAt,
      expiresAt,
      issuedAt,
      clientIp(req),
      typeof req?.get === 'function' ? truncate(req.get('user-agent') || '', 255) : ''
    ]
  );

  return {
    token,
    jti,
    expiresAt: new Date(expiresAt).toISOString(),
    player: {
      id: Number(player.id),
      username: player.username,
      isModerator: Boolean(player.is_moderator)
    }
  };
}

/**
 * Revoke a session immediately. The JWT remains cryptographically valid until
 * its expiry, so this is what actually ends access.
 *
 * @param {string} jti
 * @param {string} [reason]
 * @returns {Promise<boolean>} whether a live session was revoked
 */
async function revokeSession(jti, reason = 'revoked') {
  const result = await run(
    'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE jti = ? AND revoked_at IS NULL',
    [Date.now(), truncate(reason, 64), jti]
  );
  return result.changes > 0;
}

/**
 * Revoke every live session for a player. Used on ban and on password change.
 *
 * @param {number} playerId
 * @param {string} [reason]
 * @returns {Promise<number>} number of sessions revoked
 */
async function revokeAllSessionsForPlayer(playerId, reason = 'revoked-all') {
  const result = await run(
    'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE player_id = ? AND revoked_at IS NULL',
    [Date.now(), truncate(reason, 64), playerId]
  );
  return result.changes;
}

/**
 * Hash a token for at-rest storage. A plain SHA-256 digest is appropriate here:
 * the input is already high-entropy random data, so there is nothing for a
 * password KDF to protect against.
 *
 * @param {string} token
 * @returns {string}
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** @param {string} value @param {number} max @returns {string} */
function truncate(value, max) {
  const str = String(value ?? '');
  return str.length > max ? str.slice(0, max) : str;
}

/**
 * Best-effort client IP, honouring X-Forwarded-For only as far as `trust proxy`
 * allows. Express has already sanitised this header when trust proxy is 0.
 *
 * @param {import('express').Request} [req]
 * @returns {string}
 */
function clientIp(req) {
  try {
    if (req && typeof req.ip === 'string' && req.ip) return truncate(req.ip, 64);
  } catch {
    // fall through
  }
  return '';
}

// ---------------------------------------------------------------------------
// Request middleware
// ---------------------------------------------------------------------------

/**
 * Pull a bearer token off the request.
 *
 * Only accepts the `Bearer <token>` form. The 2017 client occasionally sends a
 * bare token with no scheme, so that is tolerated, but nothing else is.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function readBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
    // No scheme present - accept the raw value.
    if (!header.includes(' ')) return header.trim();
    return null;
  }

  // Some client builds send the token in a cookie.
  const cookies = req.cookies;
  if (cookies && typeof cookies.token === 'string' && cookies.token) return cookies.token;

  return null;
}

/**
 * Resolve a JWT + its session row into a live principal.
 *
 * Returns null with a reason rather than throwing, so callers can pick the
 * right status code.
 *
 * @param {string} token
 * @returns {Promise<{ok:true,user:object,session:object}|{ok:false,status:number,error:string}>}
 */
async function resolvePrincipal(token) {
  if (!token) return { ok: false, status: 401, error: 'Access token required' };

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, {
      algorithms: [TOKEN_ALGORITHM] // pinned: blocks "alg: none" and HMAC/RSA confusion
    });
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    return {
      ok: false,
      status: 401,
      error: expired ? 'Session expired' : 'Invalid token'
    };
  }

  if (!claims || typeof claims !== 'object') {
    return { ok: false, status: 401, error: 'Invalid token' };
  }

  const playerId = Number(claims.id);
  if (!Number.isSafeInteger(playerId) || playerId <= 0 || typeof claims.jti !== 'string') {
    return { ok: false, status: 401, error: 'Invalid token' };
  }

  const session = await get('SELECT * FROM sessions WHERE jti = ?', [claims.jti]);
  if (!session) {
    return { ok: false, status: 401, error: 'Session not found' };
  }
  if (session.player_id !== playerId) {
    // Token and session disagree. Treat as forged rather than a stale client.
    return { ok: false, status: 401, error: 'Invalid token' };
  }
  if (session.revoked_at) {
    return { ok: false, status: 401, error: 'Session revoked' };
  }
  if (session.expires_at <= Date.now()) {
    return { ok: false, status: 401, error: 'Session expired' };
  }

  // Live player state. This is the step that makes bans and deletions take
  // effect immediately instead of at token expiry.
  const player = await get(
    `SELECT id, username, display_name, is_banned, moderation_data, is_moderator, token_version
       FROM players WHERE id = ?`,
    [playerId]
  );
  if (!player) {
    return { ok: false, status: 401, error: 'Account no longer exists' };
  }
  if (Number(player.token_version || 0) !== Number(claims.tv || 0)) {
    // Bumped to invalidate every outstanding token for this account at once.
    return { ok: false, status: 401, error: 'Session invalidated' };
  }
  if (player.is_banned) {
    const moderation = parseModerationData(player.moderation_data ?? player.is_banned);
    if (moderation && moderation.banned && !moderationExpired(moderation)) {
      return { ok: false, status: 403, error: 'Account is suspended' };
    }
  }

  const user = {
    id: Number(player.id),
    username: player.username,
    displayName: player.display_name,
    jti: claims.jti,
    role: player.is_moderator ? ROLE_MODERATOR : ROLE_PLAYER,
    isModerator: Boolean(player.is_moderator)
  };

  return { ok: true, user, session };
}

/**
 * Parse moderation_data, tolerating a legacy integer is_banned value.
 * @param {string|number} raw
 * @returns {{banned:boolean,reason:string,expires:number}|null}
 */
function parseModerationData(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' || /^[01]$/.test(String(raw))) {
    return { banned: Number(raw) === 1, reason: '', expires: 0 };
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      banned: Boolean(parsed.banned),
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      expires: Number(parsed.expires) || 0
    };
  } catch {
    return null;
  }
}

/**
 * A ban with expires === 0 never lifts. Otherwise expires is unix seconds.
 * @param {{expires:number}} moderation
 * @returns {boolean}
 */
function moderationExpired(moderation) {
  if (!moderation.expires) return false;
  return moderation.expires <= Math.floor(Date.now() / 1000);
}

/**
 * Record that a session was used, rate-limited to one write per interval so a
 * busy client does not generate a database write per request.
 *
 * @param {object} session
 */
function touchSession(session) {
  if (!session) return;
  const now = Date.now();
  if (now - Number(session.last_seen_at || 0) < config.sessionTouchIntervalMs) return;
  session.last_seen_at = now; // update in place so later requests in this window skip the write
  run('UPDATE sessions SET last_seen_at = ? WHERE jti = ?', [now, session.jti]).catch(() => {});
}

/**
 * Require a valid, live session.
 * @type {import('express').RequestHandler}
 */
async function requireAuth(req, res, next) {
  const token = readBearerToken(req);
  const result = await resolvePrincipal(token);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  req.user = result.user;
  req.session = result.session;
  touchSession(result.session);
  next();
}

/**
 * Attach the principal when a valid token is present, but allow anonymous access.
 *
 * Note the deliberate change from the previous behaviour: a token that is
 * present but invalid is now a 401, not a silent downgrade to anonymous. That
 * silent fallback was the mechanism behind the "anonymous requests mutate the
 * oldest account" bug - a stale or forged token quietly became player #1.
 *
 * @type {import('express').RequestHandler}
 */
async function optionalAuth(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    req.user = null;
    return next();
  }

  const result = await resolvePrincipal(token);
  if (!result.ok) {
    if (result.status === 403) {
      // Suspended account: refuse outright even on an optional route, so a
      // banned client cannot quietly continue using read endpoints.
      return res.status(403).json({ error: result.error });
    }
    return res.status(401).json({ error: result.error });
  }

  req.user = result.user;
  req.session = result.session;
  touchSession(result.session);
  next();
}

/**
 * Read the presented admin key, if any.
 * @param {import('express').Request} req
 * @returns {string}
 */
function readAdminKey(req) {
  const header = req.headers?.['x-admin-key'];
  if (typeof header === 'string' && header) return header.trim();
  if (Array.isArray(header) && typeof header[0] === 'string') return header[0].trim();
  const auth = req.headers?.authorization;
  if (typeof auth === 'string') {
    const match = /^Admin\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return '';
}

/**
 * True when the request presented the configured admin key.
 *
 * Compares in constant time via safeEqual. The previous `!==` comparison leaked
 * the key one byte at a time.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function hasAdminKey(req) {
  const presented = readAdminKey(req);
  if (!presented) return false;
  return safeEqual(presented, config.adminKey);
}

/**
 * Require either the admin key or a moderator account.
 *
 * Guards /dashboard, /api/dashboard/* and /api/moderation/*.
 *
 * @type {import('express').RequestHandler}
 */
function requireAdmin(req, res, next) {
  if (hasAdminKey(req)) {
    req.user = req.user || null;
    req.viaAdminKey = true;
    return next();
  }
  if (req.user?.isModerator) return next();
  return res.status(401).json({ error: 'Administrator access required' });
}

/**
 * Require a logged-in player, and additionally verify the caller owns the
 * resource named by `req.params[param]`.
 *
 * This replaces the pattern where the acting player was read from the
 * x-rec-room-profile request header - a value any client could set to any id.
 *
 * @param {string} [param='playerId'] route parameter holding the target id
 * @returns {import('express').RequestHandler}
 */
function requireSelf(param = 'playerId') {
  return function handler(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Access token required' });
    }
    const target = req.params?.[param];
    if (target !== undefined && Number(target) !== req.user.id) {
      return res.status(403).json({ error: 'Cannot act on another player' });
    }
    return next();
  };
}

/**
 * The authenticated player's id, or null.
 *
 * Identity comes only from a verified session. There is deliberately no header
 * or query-string fallback - that was the root of the IDOR findings.
 *
 * @param {import('express').Request} req
 * @returns {number|null}
 */
function playerIdOf(req) {
  return req.user ? req.user.id : null;
}

/**
 * Parse a positive integer route/body value.
 * @param {unknown} value
 * @returns {number|null}
 */
function toPlayerId(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

module.exports = {
  ROLE_PLAYER,
  ROLE_MODERATOR,
  issueSession,
  revokeSession,
  revokeAllSessionsForPlayer,
  resolvePrincipal,
  requireAuth,
  optionalAuth,
  requireAdmin,
  requireSelf,
  hasAdminKey,
  readBearerToken,
  parseModerationData,
  moderationExpired,
  playerIdOf,
  toPlayerId,
  truncate
};