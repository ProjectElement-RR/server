const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const { requireAuth } = require('../lib/auth');

// Get gallery for website (public - shows saved images from all players)
router.get('/', async (req, res) => {
  try {
    const images = await all(
      'SELECT i.*, p.username FROM images i LEFT JOIN players p ON i.player_id = p.id WHERE i.image_type = "saved" ORDER BY i.uploaded_at DESC LIMIT 50'
    );

    const processedImages = (images || []).map((img) => ({
      ...img,
      username: img.username || 'Unknown'
    }));

    return res.json(processedImages);
  } catch (err) {
    console.error('[Gallery] web gallery failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch gallery' });
  }
});

// Get player's gallery (requires auth, self-only)
router.get('/player/:id', requireAuth, async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid player id' });
  }

  // Players can only view their own gallery
  if (targetId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot view another player gallery' });
  }

  try {
    const images = await all(
      'SELECT * FROM images WHERE player_id = ? ORDER BY uploaded_at DESC',
      [targetId]
    );
    return res.json(images || []);
  } catch (err) {
    console.error('[Gallery] player gallery failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch images' });
  }
});

module.exports = router;