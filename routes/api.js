const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Version check - always valid for 2017
router.get('/versioncheck/v1', (req, res) => {
  res.json({ ValidVersion: true });
});

// Launcher startup
router.get('/launcher/startup', (req, res) => {
  res.send('[Yep that shit went]');
});

// Amplitude.
// Rec.js serves this as GET returning a JSON object; some 2017 builds parse the
// body, so return real JSON rather than a bare string.
router.get('/config/v1/amplitude', (req, res) => {
  res.json({ AmplitudeKey: 'NoKeyProvided' });
});

router.post('/config/v1/amplitude', (req, res) => {
  res.json({ AmplitudeKey: 'NoKeyProvided' });
});

// Presence list
router.post('/presence/v1/list', (req, res) => {
  res.json({
    Id: 2,
    PlayerID: 1,
    RelationshipType: 3,
    Favorited: 1,
    Muted: 0,
    Ignored: 0
  });
});

// Presence v2
router.post('/presence/v2', (req, res) => {
  res.json([]);
});

// PlayersBanned - present in the June/July 2017 client but in neither Rec.js
// nor LunarRec, so there is no reference shape. There is no ban feature here,
// so return an empty list; without a handler at all the request would 404.
router.get('/PlayersBanned/*', (req, res) => {
  res.json([]);
});

router.post('/PlayersBanned/*', (req, res) => {
  res.json([]);
});

// Objectives progress
router.get('/objectives/v1/myprogress', (req, res) => {
  res.json({
    Objectives: [
      { Index: 2, Group: 0, Progress: 0.0, VisualProgress: 0.0, IsCompleted: true, IsRewarded: true },
      { Index: 1, Group: 0, Progress: 0.0, VisualProgress: 0.0, IsCompleted: true, IsRewarded: true },
      { Index: 0, Group: 0, Progress: 0.0, VisualProgress: 0.0, IsCompleted: true, IsRewarded: true }
    ],
    ObjectiveGroups: [
      { Group: 0, IsCompleted: false, ClearedAt: '2021-04-18T01:59:14.8642558' }
    ]
  });
});

// Charades words.
// Rec.js registers this as GET and returns an ARRAY of {EN_US, Difficulty}
// parsed from charades.txt (lines starting with "//" are comments). Some builds
// POST instead, so serve both. A single object makes the word list render wrong.
function loadCharades() {
  try {
    const file = path.join(__dirname, '../data/charades_words.txt');
    return fs.readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .filter(line => line.trim() && !line.trim().startsWith('//') && !line.trim().startsWith('#'))
      .map(line => ({ EN_US: line.trim(), Difficulty: 0 }));
  } catch (e) {
    return [{ EN_US: 'Rec Room', Difficulty: 0 }];
  }
}

router.get('/activities/charades/v1/words', (req, res) => {
  res.json(loadCharades());
});

router.post('/activities/charades/v1/words', (req, res) => {
  res.json(loadCharades());
});

// Version check wildcard - the 2017 client appends its build number
// (e.g. /api/versioncheck/v2017xxxx). Only /v1 was handled before, so newer
// builds got a 404 and refused to continue past the splash screen.
router.get('/versioncheck/*', (req, res) => {
  res.json({ ValidVersion: true });
});

// Player settings - catch-all for any missing playersettings endpoints
router.all('/playersettings/*', (req, res) => {
  console.log('[API] Player settings called:', req.url);
  res.json([]);
});

// Avatar player settings - specific endpoint the client might be calling
router.all('/avatarplayersettings/*', (req, res) => {
  console.log('[API] Avatar player settings called:', req.url);
  res.json({
    avatarData: {},
    OutfitSelections: [],
    HairColor: '#FFFFFF',
    SkinColor: '#FFFFFF',
    FaceFeatures: {}
  });
});

// Notification endpoints - required for 2017 client to avoid "failed to connect to recnet"
// The 2017 client expects these endpoints for notification/hub functionality
router.get('/Notifications/hub/v1', (req, res) => {
  console.log('[API] Notifications hub v1 called');
  res.json({
    url: '/Notifications/hub/v1',
    enabled: true
  });
});

router.post('/Notifications/hub/v1/negotiate', (req, res) => {
  console.log('[API] Notifications hub negotiate called');
  res.json({
    url: '/Notifications/hub/v1',
    accessToken: '',
    connectionId: '',
    availableTransports: []
  });
});

router.get('/Notifications/crm/me/config/v3', (req, res) => {
  console.log('[API] Notifications CRM config v3 called');
  res.json({
    enabled: false,
    config: {}
  });
});

// Catch-all for any other notification endpoints
router.all('/Notifications/*', (req, res) => {
  console.log('[API] Notifications endpoint called:', req.url);
  res.json({});
});

// Islanded versions check - some 2017 builds call this
router.get('/versioncheck/islandedversions', (req, res) => {
  console.log('[API] Version check islandedversions called');
  res.json([]);
});

// Match player login - authentication endpoint
router.post('/match/player/login', (req, res) => {
  console.log('[API] Match player login called');
  res.json({
    success: true,
    player_id: 1,
    token: ''
  });
});

// Auth connect token - OAuth token endpoint
router.post('/auth/connect/token', (req, res) => {
  console.log('[API] Auth connect token called');
  res.json({
    access_token: '',
    token_type: 'Bearer',
    expires_in: 3600
  });
});

// Catch-all for any other auth-related endpoints
router.all('/auth/*', (req, res) => {
  console.log('[API] Auth endpoint called:', req.url);
  res.json({});
});

// Catch-all for any other match-related endpoints
router.all('/match/*', (req, res) => {
  console.log('[API] Match endpoint called:', req.url);
  res.json({});
});

module.exports = router;
