// /api/PlayerSubscriptions/*
//
// Ported from Rec.js servers/2017/APIServer.js. No subscription system here,
// so both calls answer with the empty array the 2017 client expects.

const express = require('express');
const router = express.Router();

router.post('/v1/init', (req, res) => {
  res.json([]);
});

router.post('/v1/add', (req, res) => {
  res.json([]);
});

module.exports = router;
