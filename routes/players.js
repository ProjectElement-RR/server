const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const jwt = require('jsonwebtoken');
const { publicProfile, ensureDefaultPlayer, ensurePlayerByPlatformId } = require('../lib/player2017');
const { requireAuth, optionalAuth, playerIdOf } = require('../lib/auth');
const { webhookMessage, dataType } = require('../lib/webhook');
const { normalizeAvatarPayload } = require('../lib/avatarValidation');
const { isPlayerOnline } = require('../lib/wsServer2017');
const rateLimit = require('express-rate-limit');
const { config } = require('../lib/config');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-key';

// XP constants shared with challenge.js
const OBJECTIVE_XP = 100;
const MAX_XP_PER_REQUEST = 10000;
const XP_PER_LEVEL = 1000;

function levelForXp(xp) {
  return Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1;
}

async function awardXp(playerId, amount) {
  const applied = Math.max(0, Math.min(Math.floor(amount) || 0, MAX_XP_PER_REQUEST));

  return transaction(async (tx) => {
    const player = await tx.get('SELECT id, xp FROM players WHERE id = ?', [playerId]);
    if (!player) throw new Error('Player not found');

    const newXp = Math.max(0, Number(player.xp || 0) + applied);
    const newLevel = levelForXp(newXp);

    await tx.run('UPDATE players SET xp = ?, level = ? WHERE id = ?', [newXp, newLevel, playerId]);

    return { xp: newXp, level: newLevel, applied };
  });
}

// Rate limiting for player list endpoints
const playerListLimiter = rateLimit({
  windowMs: 60000,
  max: 200,
  message: { error: 'Too many player list requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`[RateLimit] Player list request blocked from IP: ${req.ip}`);
    res.status(429).json({ error: 'Too many player list requests, please try again later' });
  }
});

// Get or create player (anonymous, used for initial login)
//
// Creates a session JWT but does NOT store it in the database - the token is
// self-contained and validated via the JWT signature. Storing tokens in the DB
// created a revocation mechanism that was never used and leaked tokens if the DB
// was dumped.
router.post('/v1/getorcreate', async (req, res) => {
  const { Name, steam_id } = req.body;
  const playerName = Name ?? steam_id;

  if (!playerName) {
    return res.status(400).json({ error: 'Name or steam_id required' });
  }

  try {
    // Find by username (case-insensitive) or steam_id
    const player = await get(
      'SELECT * FROM players WHERE LOWER(username) = LOWER(?) OR steam_id = ?',
      [playerName, steam_id]
    );

    if (player) {
      if (player.is_banned) {
        return res.status(403).json({ error: 'Account is banned' });
      }

      const sessionToken = jwt.sign(
        { id: player.id, username: player.username },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.json({
        Id: player.id,
        Username: player.username,
        SteamId: player.steam_id,
        XP: player.xp,
        Level: player.level,
        Token: sessionToken,
        CreatedAt: player.created_at
      });
    }

    // Create new player - use AUTOINCREMENT integer ID
    const result = await run(
      'INSERT INTO players (username, display_name, steam_id, xp, level) VALUES (?, ?, ?, ?, ?)',
      [playerName, playerName, steam_id, 0, 1]
    );

    const newPlayerId = result.lastID;
    const sessionToken = jwt.sign(
      { id: newPlayerId, username: playerName },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    webhookMessage(dataType.AccountCreate, { username: playerName, id: newPlayerId });

    return res.json({
      Id: newPlayerId,
      Username: playerName,
      DisplayName: playerName,
      SteamId: steam_id,
      XP: 0,
      Level: 1,
      Token: sessionToken,
      CreatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[Players] getorcreate failed:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// List players by ID
//
// Requires a session. The client supplies an array of numeric IDs; each is
// validated as a safe integer. The result set is capped to prevent enumeration
// of the entire player table.
router.post('/v1/list', playerListLimiter, requireAuth, async (req, res) => {
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  // Validate and deduplicate
  const validIds = [...new Set(ids)]
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 100);

  if (validIds.length === 0) {
    return res.json([]);
  }

  console.log(`[Players] v1/list called for player IDs:`, validIds);

  try {
    const placeholders = validIds.map(() => '?').join(',');
    const players = await all(
      `SELECT id, username, display_name, xp, level, avatar, profile_image FROM players WHERE id IN (${placeholders})`,
      validIds
    );

    const formattedPlayers = (players || []).map((p) => {
      let avatarData = {};
      try {
        if (p.avatar) avatarData = JSON.parse(p.avatar);
      } catch {
        avatarData = {};
      }

      const normalizedAvatar = normalizeAvatarPayload(avatarData);
      normalizedAvatar.ProfileImageName = String(p.id);

      return {
        Id: p.id,
        Username: p.username,
        DisplayName: p.display_name || p.username,
        XP: p.xp,
        Level: p.level,
        Avatar: normalizedAvatar
      };
    });

    return res.json(formattedPlayers);
  } catch (err) {
    console.error('[Players] list failed:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Platform login (Steam/Oculus/etc.)
//
// Creates/looks up a player by platform_id and returns a session JWT. The
// platform_id is stored as steam_id in the players table for historical reasons.
router.post('/platformlogin/v1', async (req, res) => {
  const { platform_id } = req.body;

  if (!platform_id) {
    return res.status(400).json({ error: 'platform_id required' });
  }

  try {
    const player = await new Promise((resolve, reject) => {
      ensurePlayerByPlatformId(platform_id, (err, p) => {
        if (err) reject(err);
        else resolve(p);
      });
    });

    if (player.is_banned) {
      return res.status(403).json({ Error: 'Account is banned' });
    }

    const sessionToken = jwt.sign(
      { id: player.id, username: player.username, steam_id: player.steam_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Note: we intentionally do NOT write session_token to the database.
    // The JWT is self-validating; server-side revocation is not implemented.
    webhookMessage(dataType.PlayerOnline, { username: player.username, id: player.id });

    return res.json({
      Token: sessionToken,
      PlayerId: String(player.id),
      Error: ''
    });
  } catch (err) {
    console.error('[Players] platformlogin failed:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get online players count - real-time from WebSocket tracking
router.get('/v1/onlinecount', async (req, res) => {
  try {
    const { wsConnections } = require('../lib/wsServer2017');
    return res.json({ count: wsConnections.size });
  } catch (e) {
    console.error('Error getting online count:', e);
    // Fallback to database
    try {
      const row = await get('SELECT COUNT(*) as count FROM players');
      return res.json({ count: row ? row.count : 0 });
    } catch (err) {
      console.error('[Players] onlinecount fallback failed:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
  }
});

// Get total players count
router.get('/v1/total', async (req, res) => {
  try {
    const row = await get('SELECT COUNT(*) as count FROM players');
    return res.json({ count: row ? row.count : 0 });
  } catch (err) {
    console.error('[Players] total failed:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get player by ID (public profile)
//
// Optional auth. Returns a public profile; the endpoint is deliberately not
// rate-limited because the 2017 client calls it frequently for lobby UI. The
// response contains no sensitive fields.
router.get('/v1/:id', optionalAuth, async (req, res) => {
  const playerId = Number(req.params.id);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) {
    return res.status(400).json({ Error: 'Invalid player id' });
  }

  try {
    const player = await get('SELECT * FROM players WHERE id = ?', [playerId]);
    if (player) {
      return res.json(publicProfile(player));
    }

    // Fallback: return 404 for non-existent player
    return res.status(404).json({ Error: 'Player not found' });
  } catch (err) {
    console.error('[Players] get by id failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

// Complete objective (authenticated, session identity)
//
// Replaces the header-based /v1/objective/:playerId and /v1/objectives endpoints.
// XP is capped per request; level is recomputed from the new total.
//
// The 2017 client POSTs a JSON *array* of objective entries to /v1/objectives,
// while other callers send a single object, so both shapes are accepted here.
// Reading `req.body.objectiveType` directly returned undefined for an array,
// which made every client objective completion fail with a 400.
async function completeObjectives(playerId, body) {
  const entries = Array.isArray(body) ? body : [body];

  if (!entries.length) {
    return { status: 400, body: { error: 'Objective type required' } };
  }

  let xpAwarded = 0;
  let lastXp = 0;
  let lastLevel = 1;
  let lastObjectiveType = null;

  for (const entry of entries) {
    const objectiveType = entry?.objectiveType ?? entry?.ObjectiveType;
    if (objectiveType === undefined || objectiveType === null || objectiveType === '') {
      return { status: 400, body: { error: 'Objective type required' } };
    }
    const additionalXp = entry.additionalXp ?? entry.AdditionalXp;

    const totalAward = OBJECTIVE_XP + Math.max(0, Math.floor(Number(additionalXp) || 0));
    const result = await awardXp(playerId, totalAward);

    await run(
      `INSERT INTO player_objectives (player_id, objective_type, completed_count, last_completed_at)
       VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(player_id, objective_type)
       DO UPDATE SET completed_count = completed_count + 1, last_completed_at = datetime('now')`,
      [playerId, objectiveType]
    );

    xpAwarded += result.applied;
    lastXp = result.xp;
    lastLevel = result.level;
    lastObjectiveType = objectiveType;
  }

  return {
    status: 200,
    body: {
      Success: true,
      XPReward: xpAwarded,
      TotalXp: lastXp,
      Level: lastLevel,
      ObjectiveType: lastObjectiveType
    }
  };
}

router.post('/v1/objective', requireAuth, async (req, res) => {
  try {
    const outcome = await completeObjectives(req.user.id, req.body);
    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('[Players] objective failed:', err.message);
    return res.status(500).json({ error: 'Failed to complete objective' });
  }
});

// Legacy /v1/objectives - kept for client compatibility, delegates to session
router.post('/v1/objectives', requireAuth, async (req, res) => {
  try {
    const outcome = await completeObjectives(req.user.id, req.body);
    return res.status(outcome.status).json(outcome.body);
  } catch (err) {
    console.error('[Players] objectives failed:', err.message);
    return res.status(500).json({ error: 'Failed to complete objective' });
  }
});

// Update display name (authenticated)
router.post('/v1/displayname', requireAuth, async (req, res) => {
  const { Name } = req.body;
  const playerId = req.user.id;

  if (!Name || typeof Name !== 'string' || !Name.trim()) {
    return res.status(400).json({ error: 'Name required' });
  }

  const displayName = Name.trim().slice(0, 32);

  try {
    await run('UPDATE players SET display_name = ? WHERE id = ?', [displayName, playerId]);
    return res.json({ Success: true, Message: `Display name updated to "${displayName}"` });
  } catch (err) {
    console.error('[Players] displayname failed:', err.message);
    return res.status(500).json({ Success: false, Message: 'Failed to update display name' });
  }
});

// Player search (anonymous, rate-limited by IP via global limiter)
router.get('/v2/search', async (req, res) => {
  const { name } = req.query;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name parameter required' });
  }

  const searchName = `%${name.toLowerCase()}%`;

  try {
    const players = await all(
      'SELECT id, username, display_name, xp, level, created_at FROM players WHERE LOWER(username) LIKE ? OR LOWER(display_name) LIKE ? LIMIT 10',
      [searchName, searchName]
    );

    const formattedPlayers = (players || []).map((p) => ({
      Id: p.id,
      Username: p.username,
      DisplayName: p.display_name || p.username,
      XP: p.xp,
      Level: p.level,
      CreatedAt: p.created_at
    }));

    return res.json(formattedPlayers);
  } catch (err) {
    console.error('[Players] search failed:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

// List players by platform ID (Steam ID)
//
// Requires a session. Validates each platform ID as a non-empty string.
router.post('/v1/listByPlatformId', playerListLimiter, requireAuth, async (req, res) => {
  const { platformIds } = req.body;

  if (!platformIds || !Array.isArray(platformIds)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const validIds = [...new Set(platformIds)]
    .map((id) => String(id).trim())
    .filter((id) => id.length > 0 && id.length <= 64)
    .slice(0, 100);

  if (validIds.length === 0) {
    return res.json([]);
  }

  console.log(`[Players] v1/listByPlatformId called for platform IDs:`, validIds);

  try {
    const placeholders = validIds.map(() => '?').join(',');
    const players = await all(
      `SELECT id, username, display_name, steam_id, xp, level, avatar, profile_image FROM players WHERE steam_id IN (${placeholders})`,
      validIds
    );

    const formattedPlayers = (players || []).map((p) => {
      let avatarData = {};
      try {
        if (p.avatar) avatarData = JSON.parse(p.avatar);
      } catch {
        avatarData = {};
      }

      const normalizedAvatar = normalizeAvatarPayload(avatarData);
      normalizedAvatar.ProfileImageName = String(p.id);

      return {
        Id: p.id,
        Username: p.username,
        DisplayName: p.display_name || p.username,
        SteamId: p.steam_id,
        XP: p.xp,
        Level: p.level,
        Avatar: normalizedAvatar,
        IsOnline: isPlayerOnline(p.id)
      };
    });

    return res.json(formattedPlayers);
  } catch (err) {
    console.error('[Players] listByPlatformId failed:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
module.exports.playerListLimiter = playerListLimiter;