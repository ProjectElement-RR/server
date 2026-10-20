// /api/events/*
//
// Ported from Rec.js servers/2017/APIServer.js. No event system here yet, so
// this returns the empty list the 2017 client expects.

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

router.get('/v*/list', (req, res) => {
  res.json([]);
});

// Charades words endpoint
router.get('/v*/activities/charades/v*/words', (req, res) => {
  const charadesPath = path.join(__dirname, '..', 'data', 'charades_words.txt');

  try {
    if (fs.existsSync(charadesPath)) {
      const content = fs.readFileSync(charadesPath, 'utf8');
      const words = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(word => ({ EN_US: word, Difficulty: 0 }));

      res.json(words);
    } else {
      // Fallback words if file doesn't exist
      res.json([
        { EN_US: 'Basketball', Difficulty: 0 },
        { EN_US: 'Football', Difficulty: 0 },
        { EN_US: 'Soccer', Difficulty: 0 },
        { EN_US: 'Tennis', Difficulty: 0 },
        { EN_US: 'Baseball', Difficulty: 0 }
      ]);
    }
  } catch (err) {
    console.error('Error reading charades words:', err);
    res.json([]);
  }
});

module.exports = router;
