const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const { requireAuth, optionalAuth } = require('../lib/auth');
const { normalizeAvatarPayload, validateAvatar, DEFAULT_SAFE_AVATAR } = require('../lib/avatarValidation');
const rateLimit = require('express-rate-limit');

const avatarSetLimiter = rateLimit({
  windowMs: 60000,
  max: 100,
  message: { error: 'Too many avatar save requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`[RateLimit] Avatar set request blocked from IP: ${req.ip}`);
    res.status(429).json({ error: 'Too many avatar save requests, please try again later' });
  }
});

/**
 * Fetch and return a player's avatar (or default).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} playerId
 */
async function respondWithAvatar(req, res, playerId) {
  try {
    const player = await get('SELECT avatar FROM players WHERE id = ?', [playerId]);
    if (player && player.avatar) {
      try {
        const avatarData = JSON.parse(player.avatar);
        if (avatarData && Object.keys(avatarData).length > 0) {
          const normalized = normalizeAvatarPayload(avatarData);
          normalized.ProfileImageName = String(playerId);
          return res.json(normalized);
        }
      } catch {
        // Fall through to default
      }
    }

    const defaultAvatar = JSON.parse(JSON.stringify(DEFAULT_SAFE_AVATAR));
    defaultAvatar.ProfileImageName = String(playerId);
    return res.json(defaultAvatar);
  } catch (err) {
    console.error('[Avatar] Database error:', err.message);
    return res.status(500).send('');
  }
}

// Get avatar data - v1 (legacy 2017 client format)
router.get('/v1', optionalAuth, async (req, res) => {
  const playerId = req.user?.id;
  if (playerId) {
    return respondWithAvatar(req, res, playerId);
  }

  // Unauthenticated: return default avatar
  const defaultAvatar = JSON.parse(JSON.stringify(DEFAULT_SAFE_AVATAR));
  defaultAvatar.ProfileImageName = '1';
  return res.json(defaultAvatar);
});

// Get avatar data - v2 (Rec-Room-Patches normalized format)
router.get('/v2', optionalAuth, async (req, res) => {
  const playerId = req.user?.id;
  if (playerId) {
    return respondWithAvatar(req, res, playerId);
  }

  // Unauthenticated: return default avatar
  const defaultAvatar = JSON.parse(JSON.stringify(DEFAULT_SAFE_AVATAR));
  defaultAvatar.ProfileImageName = '1';
  return res.json(defaultAvatar);
});

// Set avatar data with validation
//
// Requires a session. The previous version used optionalAuth and fell back to
// the default player, allowing unauthenticated callers to overwrite the default
// player's avatar. Now a valid session is mandatory.
router.post('/v2/set', avatarSetLimiter, requireAuth, async (req, res) => {
  const playerId = req.user.id;

  console.log('[Avatar] v2/set called for player', playerId, 'with body:', JSON.stringify(req.body).substring(0, 200));

  try {
    const player = await get('SELECT * FROM players WHERE id = ?', [playerId]);
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const { OutfitSelections, HairColor, SkinColor, FaceFeatures } = req.body;

    const normalizedAvatar = normalizeAvatarPayload({
      OutfitSelections,
      HairColor,
      SkinColor,
      FaceFeatures
    });

    const validation = validateAvatar(normalizedAvatar);
    if (!validation.valid) {
      console.error('[Avatar] Validation failed for player', playerId, ':', validation.errors);
      const safeAvatar = JSON.parse(JSON.stringify(DEFAULT_SAFE_AVATAR));
      normalizedAvatar.OutfitSelections = safeAvatar.OutfitSelections;
      normalizedAvatar.HairColor = safeAvatar.HairColor;
      normalizedAvatar.SkinColor = safeAvatar.SkinColor;
    }

    normalizedAvatar.ProfileImageName = String(playerId);

    const avatarDataString = JSON.stringify(normalizedAvatar);
    console.log('[Avatar] Saving avatar for player', playerId, ':', avatarDataString.substring(0, 100));

    await run('UPDATE players SET avatar = ? WHERE id = ?', [avatarDataString, playerId]);
    console.log('[Avatar] Avatar saved successfully for player', playerId);
    return res.send('');
  } catch (err) {
    console.error('[Avatar] Save failed:', err.message);
    return res.status(500).json({ error: 'Failed to update avatar' });
  }
});

// Get avatar items (static file or defaults)
router.get('/v3/items', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const avatarItemsFile = path.join(__dirname, '..', 'data', 'avataritems.txt');

  try {
    if (fs.existsSync(avatarItemsFile)) {
      const raw = fs.readFileSync(avatarItemsFile, 'utf8').trim();
      if (raw) {
        return res.type('application/json').send(raw);
      }
    }
  } catch {
    // Ignore, fall through to defaults
  }

  return res.json([
    { UnlockedLevel: 1, AvatarItemDesc: 'da55bfc3-47b7-46f6-b548-7fb2c2a5e0bf,,,' },
    { UnlockedLevel: 1, AvatarItemDesc: 'b02053b3-013f-42b0-8881-85f5be2b8cda,,,' },
    { UnlockedLevel: 1, AvatarItemDesc: '62ce4109-8dee-4895-bf1b-bfa143db4c7e,,,' }
  ]);
});

// Get gifts
router.get('/v2/gifts', (req, res) => {
  return res.json([
    {
      Id: 2,
      AvatarItemDesc: '274cb9b2-2f59-47ea-9a8d-a5b656d148c6',
      Xp: 50
    }
  ]);
});

// Consume gift
router.post('/v2/gifts/consume', (req, res) => {
  return res.json({ Id: 2, UnlockedLevel: 0 });
});

// Saved avatar slots (not implemented)
router.get('/v1/saved', (req, res) => {
  return res.json([]);
});

// Catch-all for any other avatar endpoints
router.all('/*', (req, res) => {
  return res.json([]);
});

module.exports = router;