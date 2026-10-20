const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');

// Leaderboard endpoint with real data (public)
router.get('/v1', async (req, res) => {
  try {
    // Get top players by XP for global leaderboard
    const players = await all(
      'SELECT id, username, xp, level FROM players ORDER BY xp DESC LIMIT 50'
    );

    const GlobalOverall = (players || []).map((p, index) => ({
      PlayerId: p.id,
      Count: p.xp,
      Order: index + 1
    }));

    // Calculate next reset (daily at midnight UTC)
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const NextResetUTC = Math.floor(tomorrow.getTime() / 1000);

    const data = {
      GlobalOverall,
      GlobalPeriodic: GlobalOverall.slice(0, 10),
      FriendsOverall: [],
      FriendsPeriodic: [],
      NextResetUTC
    };

    return res.json(data);
  } catch (err) {
    console.error('[Leaderboard] failed:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;