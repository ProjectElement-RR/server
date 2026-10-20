// /api/messages/*
//
// Ported from Rec.js servers/2017/APIServer.js. The 2017 client polls this on
// login and is happy with an empty array - there is no message store here.

const express = require('express');
const router = express.Router();

router.get('/v2/get', (req, res) => {
  res.json([]);
});

module.exports = router;
