// /api/equipment/*
//
// Ported from Rec.js servers/2017/APIServer.js + shared/equipment.js, which
// serves the raw contents of user-info/equipment.txt.
// We serve data/equipment.txt when it has been seeded (see data/README.txt)
// and an empty array otherwise, so the endpoint never 500s.

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const EQUIPMENT_FILE = path.join(__dirname, '..', 'data', 'equipment.txt');

router.all('/v1/getUnlocked', (req, res) => {
  console.log('[Equipment] GET /v1/getUnlocked called');
  try {
    if (fs.existsSync(EQUIPMENT_FILE)) {
      const raw = fs.readFileSync(EQUIPMENT_FILE, 'utf8').trim();
      if (raw) {
        res.type('application/json').send(raw);
        return;
      }
    }
  } catch (e) {
    console.error('[equipment] failed to read equipment.txt:', e.message);
  }
  res.json([]);
});

module.exports = router;
