// Activity-specific endpoints from server.2017M
// Charades words endpoint for 2017 client

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Load charades words from file
function loadCharadesWords() {
  const charadesFile = path.join(__dirname, '..', 'data', 'charades_words.txt');

  try {
    if (fs.existsSync(charadesFile)) {
      const content = fs.readFileSync(charadesFile, 'utf8');
      // Filter out comments (lines starting with #) and empty lines
      const words = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));

      // Format as array of objects with EN_US field (server.2017M format)
      return words.map(word => ({ EN_US: word, Difficulty: 0 }));
    }
  } catch (err) {
    console.error('Error loading charades words:', err);
  }

  // Fallback words if file doesn't exist
  const fallbackWords = [
    'Rec Room Office',
    'David Bowie',
    'Guitar',
    'Hipster',
    'Boxing',
    'Alien',
    'Car Crash',
    'Pole Vault',
    'Spaghetti',
    'Titanic',
    'Video Game',
    'Moon Landing',
    'Avatar',
    'Coal Miner',
    'Castaway'
  ];

  return fallbackWords.map(word => ({ EN_US: word, Difficulty: 0 }));
}

// Get charades words - from server.2017M
router.get('/charades/v:version/words', (req, res) => {
  const words = loadCharadesWords();
  // Return as simple array of strings (server.2017M format)
  res.json(words);
});

module.exports = router;
