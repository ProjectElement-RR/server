// /api/PlayerReporting/*
//
// Ported from Rec.js servers/2017/APIServer.js. The 2017 client asks for the
// player's moderation/block state right after login; an all-zero payload means
// "not banned, not muted".

const express = require('express');
const router = express.Router();

router.get('/v1/moderationBlockDetails', (req, res) => {
  res.json({
    ReportCategory: 0,
    Duration: 0,
    GameSessionId: 0,
    Message: ''
  });
});

module.exports = router;
