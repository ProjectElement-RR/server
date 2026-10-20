// /api/platformlogin/*
//
// Ported from Rec.js servers/2017/APIServer.js (the platformlogin family) and
// shared/cachedlogin.js. The 2017 client will not finish logging in without
// these - it calls getcachedlogins first, then logincached/loginaccount.
// These endpoints are public (no auth required) as per 2017 protocol.

const express = require('express');
const router = express.Router();
const { run, get } = require('../database');
const { issueSession } = require('../lib/auth');
const {
  publicProfile,
  cachedLoginProfile,
  loginResponse,
  ensureDefaultPlayer,
  ensurePlayerByPlatformId,
  mintToken
} = require('../lib/player2017');
const { setSession } = require('../lib/wsServer2017');

/**
 * Check if player has an active ban.
 * @param {Object} player
 * @returns {boolean}
 */
function isPlayerBanned(player) {
  if (!player.moderation_data) return false;
  try {
    const moderationData = JSON.parse(player.moderation_data);
    if (moderationData.banned === true) {
      if (moderationData.expires > 0) {
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime < moderationData.expires) return true;
      } else {
        return true; // Permanent ban
      }
    }
  } catch (e) {
    console.error('Error parsing moderation data:', e);
  }
  return false;
}

/**
 * Extract platform ID from request body.
 * @param {any} body
 * @returns {string}
 */
function extractPlatformId(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) return body.length ? String(body[0]) : '';
  if (body.PlatformIds && body.PlatformIds.length) {
    return String(body.PlatformIds[0].PlatformId || '');
  }
  return String(body.platform_id ?? body.PlatformId ?? body.Platform ?? '');
}

/**
 * Build the standard session data object for WebSocket tracking.
 * @param {string} platformId
 * @param {number} playerId
 * @returns {Object}
 */
function buildSessionData(platformId, playerId) {
  return {
    GameSessionId: 20171,
    RegionId: 'us',
    RoomId: platformId || null,
    RecRoomId: null,
    EventId: null,
    CreatorPlayerId: playerId,
    Name: 'Rec Room Session',
    ActivityLevelId: platformId || '',
    Private: false,
    Sandbox: false,
    SupportsScreens: true,
    SupportsVR: true,
    GameInProgress: false,
    MaxCapacity: 20,
    IsFull: false
  };
}

/**
 * Common login handler - returns the login response JSON.
 * @param {Object} player
 * @param {string} platformId
 * @returns {Object}
 */
function handleLogin(player, platformId) {
  const sessionData = buildSessionData(platformId, player.id);
  setSession(player.id, sessionData);

  // Return full login response for v1 endpoints
  return loginResponse(player, platformId);
}

/**
 * Simple login handler - returns { Token, PlayerId, Error } format.
 * @param {Object} player
 * @param {string} platformId
 * @returns {Object}
 */
function handleSimpleLogin(player, platformId) {
  const sessionData = buildSessionData(platformId, player.id);
  setSession(player.id, sessionData);

  const token = mintToken(player);
  // Note: we do NOT write session_token to the database. The JWT is self-contained.
  return {
    Token: token,
    PlayerId: String(player.id),
    Error: ''
  };
}

// Cached logins list (GET/POST)
router.all('/v1/getcachedlogins', async (req, res) => {
  const platformId = extractPlatformId(req.body);
  try {
    // Simple lookup or create for compatibility
    let player = await get('SELECT * FROM players WHERE steam_id = ?', [platformId]);
    if (!player) {
      // Create player if not exists
      const username = `Player_${platformId.slice(-8)}`;
      const result = await run(
        'INSERT INTO players (username, display_name, steam_id, xp, level) VALUES (?, ?, ?, 0, 1)',
        [username, username, platformId]
      );
      player = await get('SELECT * FROM players WHERE id = ?', [result.lastID]);
    }
    return res.json([cachedLoginProfile(player, platformId)]);
  } catch (err) {
    console.error('[PlatformLogin] getcachedlogins failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

// Simple login handler - returns { Token, PlayerId, Error } format
async function simpleLogin(platformId, req) {
  let player = await get('SELECT * FROM players WHERE steam_id = ?', [platformId]);
  if (!player) {
    const username = `Player_${platformId.slice(-8)}`;
    const result = await run(
      'INSERT INTO players (username, display_name, steam_id, xp, level) VALUES (?, ?, ?, 0, 1)',
      [username, username, platformId]
    );
    player = await get('SELECT * FROM players WHERE id = ?', [result.lastID]);
  }

  const session = await issueSession(player, req);
  const sessionData = buildSessionData(platformId, player.id);
  setSession(player.id, sessionData);

  return {
    Token: session.token,
    PlayerId: String(player.id),
    Error: ''
  };
}

// Cached login -> full login response
router.post('/v1/logincached', async (req, res) => {
  const platformId = extractPlatformId(req.body);
  try {
    return res.json(await simpleLogin(platformId, req));
  } catch (err) {
    console.error('[PlatformLogin] logincached failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

// Username/password login
router.post('/v1/loginaccount', async (req, res) => {
  const platformId = extractPlatformId(req.body);
  try {
    return res.json(await simpleLogin(platformId, req));
  } catch (err) {
    console.error('[PlatformLogin] loginaccount failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

// Account creation
router.post('/v1/createaccount', async (req, res) => {
  const platformId = extractPlatformId(req.body);
  try {
    return res.json(await simpleLogin(platformId, req));
  } catch (err) {
    console.error('[PlatformLogin] createaccount failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

// Profile list
router.post('/v1/profiles', async (req, res) => {
  const platformId = extractPlatformId(req.body);
  try {
    let player = await get('SELECT * FROM players WHERE steam_id = ?', [platformId]);
    if (!player) {
      const username = `Player_${platformId.slice(-8)}`;
      const result = await run(
        'INSERT INTO players (username, display_name, steam_id, xp, level) VALUES (?, ?, ?, 0, 1)',
        [username, username, platformId]
      );
      player = await get('SELECT * FROM players WHERE id = ?', [result.lastID]);
    }
    return res.json([publicProfile(player)]);
  } catch (err) {
    console.error('[PlatformLogin] profiles failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

// Catch-all for other platformlogin versions (v2, v3, v4, ...)
// Returns simple {Token, PlayerId, Error} format matching Rec.js/LunarRec
router.post('/v*/', async (req, res) => {
  const platformId = extractPlatformId(req.body);
  try {
    return res.json(await simpleLogin(platformId, req));
  } catch (err) {
    console.error('[PlatformLogin] wildcard failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

// Compatibility: some builds POST to /v1 with no trailing slash
router.post('/v1', async (req, res) => {
  const platformId = extractPlatformId(req.body);
  try {
    return res.json(await simpleLogin(platformId, req));
  } catch (err) {
    console.error('[PlatformLogin] v1 failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

// v4 - explicit June/July 2017 login endpoint
router.post('/v4', async (req, res) => {
  const platformId = extractPlatformId(req.body);
  try {
    return res.json(await simpleLogin(platformId, req));
  } catch (err) {
    console.error('[PlatformLogin] v4 failed:', err.message);
    return res.status(500).json({ Error: 'Database error' });
  }
});

module.exports = router;