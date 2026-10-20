// /api/settings/*
//
// Ported from Rec.js servers/2017/APIServer.js + shared/settings.js.
// Settings are stored in the `settings` table per player.

const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const { requireAuth, optionalAuth } = require('../lib/auth');

const DEFAULT_SETTINGS = [
  { Key: 'MOD_BLOCKED_TIME', Value: '0' },
  { Key: 'MOD_BLOCKED_DURATION', Value: '0' },
  { Key: 'PlayerSessionCount', Value: '0' },
  { Key: 'ShowRoomCenter', Value: '1' },
  { Key: 'QualitySettings', Value: '3' },
  { Key: 'Recroom.OOBE', Value: '100' },
  { Key: 'VoiceFilter', Value: '0' },
  { Key: 'VIGNETTED_TELEPORT_ENABLED', Value: '0' },
  { Key: 'CONTINUOUS_ROTATION_MODE', Value: '0' },
  { Key: 'ROTATION_INCREMENT', Value: '0' },
  { Key: 'ROTATE_IN_PLACE_ENABLED', Value: '0' },
  { Key: 'TeleportBuffer', Value: '0' },
  { Key: 'VoiceChat', Value: '1' },
  { Key: 'PersonalBubble', Value: '0' },
  { Key: 'ShowNames', Value: '1' },
  { Key: 'H.264 plugin', Value: '1' }
];

async function loadSettings(playerId) {
  try {
    const row = await get(
      'SELECT settings_data FROM settings WHERE player_id = ? ORDER BY id DESC LIMIT 1',
      [playerId]
    );
    if (!row) return null;
    return JSON.parse(row.settings_data);
  } catch {
    return null;
  }
}

async function saveSettings(playerId, settings) {
  const data = JSON.stringify(settings);
  const row = await get('SELECT id FROM settings WHERE player_id = ? LIMIT 1', [playerId]);
  if (row) {
    await run(
      'UPDATE settings SET settings_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [data, row.id]
    );
  } else {
    await run('INSERT INTO settings (player_id, settings_data) VALUES (?, ?)', [playerId, data]);
  }
}

/**
 * Respond with settings for a given player ID.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} playerId
 */
async function respondWithSettings(req, res, playerId) {
  try {
    const settings = await loadSettings(playerId);
    if (!settings || settings.length === 0) {
      console.log('[Settings] Returning default settings (Rec.js format)');
      return res.json(DEFAULT_SETTINGS);
    }
    console.log('[Settings] Returning settings for player', playerId);
    return res.json(settings);
  } catch (err) {
    console.error('[Settings] Load error:', err.message);
    return res.json(DEFAULT_SETTINGS);
  }
}

// Get settings - optional auth (unauthenticated gets default settings)
router.get('/v2', optionalAuth, async (req, res) => {
  console.log('[Settings] GET /v2 called');
  const playerId = req.user?.id;

  if (playerId) {
    return respondWithSettings(req, res, playerId);
  }

  // Unauthenticated: return default settings
  return res.json(DEFAULT_SETTINGS);
});

// Set settings - requires auth
//
// The previous version used optionalAuth and fell back to the default player,
// allowing unauthenticated callers to modify the default player's settings.
router.post('/v2/set', requireAuth, async (req, res) => {
  console.log('[Settings] POST /v2/set called with body:', req.body);
  const playerId = req.user.id;

  try {
    // Rec.js sends a single {Key, Value}; some clients send a whole array.
    const incoming = Array.isArray(req.body) ? req.body : [req.body];

    const current = await loadSettings(playerId);
    const settings = current ? [...current] : [];

    for (const item of incoming) {
      if (!item || !item.Key || typeof item.Key !== 'string') continue;
      // Sanitize key and value
      const key = item.Key.slice(0, 64);
      const value = String(item.Value ?? '').slice(0, 256);

      const existing = settings.find((s) => s.Key === key);
      if (existing) {
        existing.Value = value;
      } else {
        settings.push({ Key: key, Value: value });
      }
    }

    await saveSettings(playerId, settings);
    return res.json([]);
  } catch (err) {
    console.error('[Settings] Save error:', err.message);
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Catch-all for any other settings endpoints (v1, v3, etc.)
router.all('/*', (req, res) => {
  console.log('[Settings] Unknown endpoint called:', req.url);
  return res.json([]);
});

module.exports = router;