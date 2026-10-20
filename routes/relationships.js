// /api/relationships/*
//
// Ported from Rec.js servers/2017/APIServer.js.
// This server has a `friends` table, so we return real rows when there are any
// and fall back to the empty array the 2017 client expects otherwise.

const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const { requireAuth } = require('../lib/auth');

// Get relationships (friends list) - requires auth, self-only
router.get('/v2/get', requireAuth, async (req, res) => {
  const playerId = req.user.id;

  try {
    const rows = await all(
      `SELECT f.friend_id AS PlayerId, f.status AS Status
         FROM friends f
        WHERE f.player_id = ?`,
      [playerId]
    );

    if (!rows || !rows.length) return res.json([]);

    return res.json(
      rows.map((r) => ({
        PlayerId: r.PlayerId,
        Favorited: 0,
        Ignored: 0,
        Muted: 0,
        RelationshipType: r.Status === 'accepted' ? 1 : 0
      }))
    );
  } catch (err) {
    console.error('[Relationships] get failed:', err.message);
    return res.json([]);
  }
});

module.exports = router;