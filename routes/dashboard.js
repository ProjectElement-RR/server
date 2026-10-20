const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const sessionManager = require('../lib/sessionManager');
const { isPlayerOnline } = require('../lib/wsServer2017');
const { requireAuth } = require('../lib/auth');
const { config } = require('../lib/config');

/**
 * Simple admin check - in a real deployment this would check a role/flag.
 * For now, we require a valid session and optionally check against a
 * configured admin player ID list.
 */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  const adminIds = config.adminPlayerIds || [];
  if (adminIds.length > 0 && !adminIds.includes(req.user.id)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}

// All dashboard endpoints require admin access
router.use(requireAuth, requireAdmin);

// Get all players for dashboard
router.get('/players', async (req, res) => {
  try {
    const players = await all(
      'SELECT id, username, display_name, xp, level, created_at, is_banned FROM players ORDER BY xp DESC'
    );

    const playersWithStatus = (players || []).map((player) => ({
      ...player,
      isOnline: isPlayerOnline(player.id)
    }));

    return res.json(playersWithStatus);
  } catch (err) {
    console.error('[Dashboard] players failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// Get all game sessions for dashboard
router.get('/sessions', async (req, res) => {
  try {
    const sessions = sessionManager.sessions.map((session) => {
      const sessionData = sessionManager.getSessionData(session);
      return {
        ...sessionData,
        playerCount: session.players.length,
        isFull: session.players.length >= session.maxCapacity
      };
    });

    return res.json(sessions || []);
  } catch (err) {
    console.error('[Dashboard] sessions failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// Get server statistics
router.get('/stats', async (req, res) => {
  try {
    const playerCount = await get('SELECT COUNT(*) as count FROM players');
    const sessionCount = sessionManager.sessions.length;
    const onlinePlayers = sessionManager.sessions.reduce(
      (total, session) => total + session.players.length,
      0
    );

    return res.json({
      totalPlayers: playerCount?.count ?? 0,
      totalSessions: sessionCount,
      onlinePlayers,
      uptime: Math.floor(process.uptime())
    });
  } catch (err) {
    console.error('[Dashboard] stats failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;