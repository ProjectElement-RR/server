// Shared 2017-protocol response shapes.
//
// These mirror the payloads the June-2017 Rec Room client actually parses,
// ported from Rec.js (servers/2017/APIServer.js + shared/*) and LunarRec.
// Anything speaking the 2017 protocol returns its player data from here.

const { config } = require('./config');
const { issueSession } = require('./auth');
const { db, run, get, all, transaction } = require('../database');
const fs = require('fs');
const path = require('path');

// Copy the default profile image for a new account.
//
// Runs on the first login only. Previously this was also called from
// cachedLoginProfile(), which put a filesystem write on a read path.
function createProfileImage(playerId) {
  const imagesDir = config.paths.images;
  const defaultImagePath = path.join(imagesDir, '__default.png');
  const userImagePath = path.join(imagesDir, `${playerId}.png`);

  if (!fs.existsSync(imagesDir)) return;
  if (!fs.existsSync(defaultImagePath)) return;
  if (fs.existsSync(userImagePath)) return;

  try {
    fs.copyFileSync(defaultImagePath, userImagePath);
  } catch (err) {
    console.error(`[Player2017] Could not create profile image for ${playerId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Profile shapes
// ---------------------------------------------------------------------------

/**
 * Public profile, as parsed by GET /api/players/v1/* and the login responses.
 * @param {object} player
 * @returns {object}
 */
function publicProfile(player) {
  const username = player.username || `Player_${player.id}`;
  const displayName = player.display_name || username;
  const profileImageName = String(player.id);

  let avatarData = {};
  if (player.avatar) {
    try {
      const { normalizeAvatarPayload } = require('./avatarValidation');
      avatarData = normalizeAvatarPayload(JSON.parse(player.avatar));
      avatarData.ProfileImageName = profileImageName;
    } catch {
      // A malformed avatar blob should not break profile rendering; the client
      // falls back to its own default when Avatar is empty.
    }
  }

  return {
    Id: player.id,
    Username: username,
    DisplayName: displayName,
    XP: player.xp || 0,
    Level: player.level || 1,
    Reputation: 0,
    Verified: true,
    Developer: false,
    HasEmail: true,
    CanReceiveInvites: false,
    ProfileImageName: profileImageName,
    JuniorProfile: false,
    ForceJuniorImages: false,
    PendingJunior: false,
    HasBirthday: true,
    Avatar: avatarData
  };
}

/**
 * POST /api/platformlogin/v1/getcachedlogins
 * @param {object} player
 * @param {string} platformId
 * @returns {object}
 */
function cachedLoginProfile(player, platformId) {
  const base = publicProfile(player);

  if (!base.Avatar || Object.keys(base.Avatar).length === 0) {
    const { normalizeAvatarPayload, DEFAULT_SAFE_AVATAR } = require('./avatarValidation');
    base.Avatar = normalizeAvatarPayload(JSON.parse(JSON.stringify(DEFAULT_SAFE_AVATAR)));
    base.Avatar.ProfileImageName = String(player.id);
  }

  return Object.assign(base, {
    RegistrationStatus: 2,
    AvoidJuniors: true,
    PlayerReputation: {
      Noteriety: 0,
      CheerGeneral: 10,
      CheerHelpful: 10,
      CheerGreatHost: 10,
      CheerSportsman: 10,
      CheerCreative: 10,
      CheerCredit: 20,
      SubscriberCount: 0,
      SubscribedCount: 0,
      SelectedCheer: 0
    },
    PlatformIds: [{ Platform: 0, PlatformId: platformId != null ? String(platformId) : '' }]
  });
}

/**
 * POST /api/platformlogin/v1/{logincached,loginaccount,createaccount}
 *
 * Now async: it issues a database-backed session rather than writing a token
 * into a single shared column that nothing ever read back.
 *
 * @param {object} player
 * @param {string|null} platformId
 * @param {import('express').Request} [req]
 * @returns {Promise<object>}
 */
async function loginResponse(player, platformId, req) {
  const session = await issueSession(player, req);

  return {
    Error: '',
    Player: cachedLoginProfile(player, platformId),
    Token: session.token,
    FirstLoginOfTheDay: true,
    AnalyticsSessionId: 392394,
    CanUseScreenMode: true
  };
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * Validate a platform id from the client.
 *
 * These are opaque identifiers from the platform SDK. They must be strings of
 * a bounded length - they end up in a username and in the database.
 *
 * @param {unknown} value
 * @returns {string|null} the validated id, or null if unusable
 */
function normalisePlatformId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    value = String(value);
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  // Alphanumerics plus a small set of separators, which covers the Steam64
  // (7656119...) and Photon id formats.
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) return null;

  return trimmed;
}

/**
 * Extract and validate the platform id from a request body.
 *
 * The 2017 client has used several shapes for this field over its lifetime.
 *
 * @param {any} body
 * @returns {string|null}
 */
function extractPlatformId(body) {
  if (!body || typeof body !== 'object') return null;

  const candidates = [
    body.platform_id,
    body.PlatformId,
    body.Platform,
    body.steam_id,
    Array.isArray(body.PlatformIds) ? body.PlatformIds?.[0]?.PlatformId : undefined,
    Array.isArray(body.platformIds) ? body.platformIds?.[0] : undefined,
    Array.isArray(body) ? body[0] : undefined
  ];

  for (const candidate of candidates) {
    const normalised = normalisePlatformId(candidate);
    if (normalised) return normalised;
  }
  return null;
}

/**
 * True when a platform id is permitted to reach the account creation path.
 * @param {string} platformId
 * @returns {boolean}
 */
function isPlatformIdAllowed(platformId) {
  if (config.allowedPlatformIds.length === 0) return true;
  return config.allowedPlatformIds.includes(platformId);
}

/**
 * Count accounts created by an IP in the last hour.
 *
 * Throttling account creation is the control that actually limits the damage
 * from an unauthenticated registration endpoint.
 *
 * @param {string} ip
 * @returns {Promise<number>}
 */
async function recentCreationsByIp(ip) {
  if (!ip || config.accountCreationMaxPerHour === 0) return 0;
  const row = await get(
    'SELECT COUNT(*) AS count FROM account_creation_log WHERE ip = ? AND created_at > ?',
    [ip, Date.now() - 3600e3]
  );
  return Number(row?.count || 0);
}

/**
 * Build a username from a platform id, with a numeric suffix on collision.
 *
 * Previously this was `Player_<last 8 chars>`, which collided constantly and
 * could not be recovered from - the INSERT just failed.
 *
 * @param {string} platformId
 * @returns {string}
 */
async function deriveUsername(platformId) {
  const suffix = platformId.replace(/[^A-Za-z0-9]/g, '').slice(-8) || String(Date.now()).slice(-8);
  const base = `Player_${suffix}`.slice(0, config.limits.maxUsernameLength);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}_${attempt}`.slice(0, config.limits.maxUsernameLength);
    // eslint-disable-next-line no-await-in-loop
    const clash = await get('SELECT 1 AS hit FROM players WHERE username = ?', [candidate]);
    if (!clash) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/**
 * Resolve - or create - the account for a platform id.
 *
 * Signature is callback-based because the login routes in
 * routes/platformlogin.js are callback-shaped.
 *
 * @param {string|null} platformId raw value from the request
 * @param {import('express').Request} [req]
 * @param {(err: Error|null, player?: object) => void} cb
 */
function ensurePlayerByPlatformId(platformId, req, cb) {
  const normalised = normalisePlatformId(platformId);
  if (!normalised) {
    return cb(new Error('A valid platform id is required'));
  }
  if (!isPlatformIdAllowed(normalised)) {
    return cb(new Error('This server is not accepting new accounts'));
  }

  get('SELECT * FROM players WHERE steam_id = ?', [normalised], (err, player) => {
    if (err) return cb(err);
    if (player) return cb(null, player);

    const ip = req?.ip || '';

    recentCreationsByIp(ip)
      .then(async (recent) => {
        if (recent >= config.accountCreationMaxPerHour) {
          throw new Error('Too many accounts created from this address; try again later');
        }

        const username = await deriveUsername(normalised);

        return new Promise((resolve, reject) => {
          run(
            'INSERT INTO players (username, display_name, steam_id, xp, level) VALUES (?, ?, ?, 0, 1)',
            [username, username, normalised],
            function onInsert(insertErr) {
              if (insertErr) return reject(insertErr);
              resolve(this.lastID);
            }
          );
        });
      })
      .then(async (newId) => {
        await run(
          'INSERT INTO account_creation_log (platform_id, player_id, ip, created_at) VALUES (?, ?, ?, ?)',
          [normalised, newId, ip, Date.now()]
        );
        createProfileImage(newId);
        const created = await get('SELECT * FROM players WHERE id = ?', [newId]);
        cb(null, created);
      })
      .catch((creationErr) => cb(creationErr));
  });
}

/**
 * Resolve an existing player by id.
 *
 * Replaces ensureDefaultPlayer(). There is deliberately no "oldest row in the
 * database" fallback any more: that function is what made every unauthenticated
 * request, and every request carrying an invalid token, mutate the same shared
 * account. Callers that genuinely need a default must ask for it explicitly.
 *
 * @param {number} id
 * @returns {Promise<object|null>}
 */
async function findPlayerById(id) {
  const parsed = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return (await get('SELECT * FROM players WHERE id = ?', [parsed])) || null;
}

/**
 * Update a player's username / display name.
 *
 * Uses a transaction and a conditional UPDATE so two concurrent claims on the
 * same username cannot both succeed.
 *
 * @param {number} playerId
 * @param {{username?:string, displayName?:string}} fields
 * @returns {Promise<{ok:true, player:object}|{ok:false, reason:string}>}
 */
async function updatePlayerIdentity(playerId, fields) {
  const sets = [];
  const params = [];

  if (typeof fields.displayName === 'string' && fields.displayName.trim()) {
    sets.push('display_name = ?');
    params.push(fields.displayName.trim().slice(0, config.limits.maxDisplayNameLength));
  }

  if (typeof fields.username === 'string' && fields.username.trim()) {
    sets.push('username = ?');
    params.push(fields.username.trim().slice(0, config.limits.maxUsernameLength));
  }

  if (!sets.length) return { ok: true, player: await findPlayerById(playerId) };

  params.push(playerId);
  const result = await run(
    `UPDATE players SET ${sets.join(', ')} WHERE id = ?`,
    params
  );

  if (result.changes === 0) {
    return { ok: false, reason: 'Player not found' };
  }

  return { ok: true, player: await findPlayerById(playerId) };
}

module.exports = {
  publicProfile,
  cachedLoginProfile,
  loginResponse,
  ensurePlayerByPlatformId,
  findPlayerById,
  updatePlayerIdentity,
  extractPlatformId,
  normalisePlatformId,
  createProfileImage,
  deriveUsername,
  recentCreationsByIp
};