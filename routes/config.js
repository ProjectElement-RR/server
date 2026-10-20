const express = require('express');
const router = express.Router();

// Daily Challenge IDs from server.2017M
const DailyChallengeId = {
  Default: -1,
  FirstSessionOfDay: 1,
  DailyObjective1: 10,
  DailyObjective2: 11,
  DailyObjective3: 12,
  OOBE_GoToLockerRoom: 20,
  OOBE_GoToActivity: 21,
  OOBE_FinishActivity: 22,
  CharadesGames: 100,
  CharadesWinsPerformer: 101,
  CharadesWinsGuesser: 102,
  DiscGolfWins: 200,
  DiscGolfGames: 201,
  DiscGolfHolesUnderPar: 202,
  DodgeballWins: 300,
  DodgeballGames: 301,
  DodgeballHits: 302,
  PaddleballGames: 400,
  PaddleballWins: 401,
  PaddleballScores: 402,
  PaintballAnyModeGames: 500,
  PaintballAnyModeWins: 501,
  PaintballAnyModeHits: 502,
  PaintballCTFWins: 600,
  PaintballCTFGames: 601,
  PaintballCTFHits: 602,
  PaintballFlagCaptures: 603,
  PaintballTeamBattleWins: 700,
  PaintballTeamBattleGames: 701,
  PaintballTeamBattleHits: 702,
  SoccerWins: 800,
  SoccerGames: 801,
  SoccerGoals: 802,
  QuestGames: 1000,
  QuestWins: 1001,
  QuestPlayerRevives: 1002,
  QuestEnemyKills: 1003,
  PaintballFreeForAllWins: 1100,
  PaintballFreeForAllGames: 1101,
  PaintballFreeForAllHits: 1102
};

// Daily objectives configuration from server.2017M
const DAILY_OBJECTIVES = [
  // Sunday
  [
    { type: DailyChallengeId.QuestGames, score: 1, xp: 100 },
    { type: DailyChallengeId.QuestEnemyKills, score: 10, xp: 100 },
    { type: DailyChallengeId.PaintballAnyModeGames, score: 1, xp: 100 },
  ],
  // Monday
  [
    { type: DailyChallengeId.PaintballCTFGames, score: 2, xp: 100 },
    { type: DailyChallengeId.OOBE_GoToActivity, score: 3, xp: 100 },
    { type: DailyChallengeId.OOBE_GoToLockerRoom, score: 1, xp: 100 },
  ],
  // Tuesday
  [
    { type: DailyChallengeId.DodgeballGames, score: 2, xp: 100 },
    { type: DailyChallengeId.DodgeballHits, score: 20, xp: 100 },
    { type: DailyChallengeId.OOBE_GoToActivity, score: 3, xp: 100 },
  ],
  // Wednesday
  [
    { type: DailyChallengeId.PaintballTeamBattleGames, score: 2, xp: 100 },
    { type: DailyChallengeId.PaintballTeamBattleHits, score: 20, xp: 100 },
    { type: DailyChallengeId.OOBE_GoToActivity, score: 3, xp: 100 },
  ],
  // Thursday
  [
    { type: DailyChallengeId.CharadesGames, score: 2, xp: 100 },
    { type: DailyChallengeId.CharadesWinsGuesser, score: 1, xp: 100 },
    { type: DailyChallengeId.CharadesWinsPerformer, score: 1, xp: 100 },
  ],
  // Friday
  [
    { type: DailyChallengeId.PaintballAnyModeGames, score: 2, xp: 100 },
    { type: DailyChallengeId.PaintballAnyModeHits, score: 20, xp: 100 },
    { type: DailyChallengeId.SoccerGames, score: 1, xp: 100 },
  ],
  // Saturday
  [
    { type: DailyChallengeId.SoccerGames, score: 1, xp: 100 },
    { type: DailyChallengeId.SoccerGoals, score: 3, xp: 100 },
    { type: DailyChallengeId.OOBE_GoToActivity, score: 3, xp: 100 },
  ],
];

// Get current daily objectives based on day of week
function getCurrentDailyObjectives() {
  const dayOfWeek = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  const index = dayOfWeek % DAILY_OBJECTIVES.length;
  return DAILY_OBJECTIVES[index];
}

// Get server config
router.all('/v2', (req, res) => {
  console.log('[Config] GET /v2 called');
  const config = {
    MessageOfTheDay: 'Welcome to the 7-12-2017 server',
    // Where the 2017 client fetches profile images. Served from /cdn on the
    // SAME host as this request so it survives a tunnel that only exposes one
    // port; falls back to the standalone CDN port when hit directly.
    CdnBaseUri: (() => {
      const proto =
        (req.get('x-forwarded-proto') || '').split(',')[0].trim() ||
        req.protocol || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      return host
        ? `${proto}://${host}/cdn/`
        : `http://localhost:${process.env.CDN_PORT || 2058}/`;
    })(),
    LevelProgressionMaps: [
      { Level: 0, RequiredXp: 0, GiftDropId: null },
      { Level: 1, RequiredXp: 10, GiftDropId: 3288 },
      { Level: 2, RequiredXp: 10, GiftDropId: 3293 },
      { Level: 3, RequiredXp: 10, GiftDropId: 3288 },
      { Level: 4, RequiredXp: 20, GiftDropId: 3293 },
      { Level: 5, RequiredXp: 20, GiftDropId: 3288 },
      { Level: 6, RequiredXp: 20, GiftDropId: 3293 },
      { Level: 7, RequiredXp: 20, GiftDropId: 3288 },
      { Level: 8, RequiredXp: 20, GiftDropId: 3293 },
      { Level: 9, RequiredXp: 20, GiftDropId: 3288 },
      { Level: 10, RequiredXp: 20, GiftDropId: 3293 },
      { Level: 11, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 12, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 13, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 14, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 15, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 16, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 17, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 18, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 19, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 20, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 21, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 22, RequiredXp: 115, GiftDropId: 3292 },
      { Level: 23, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 24, RequiredXp: 115, GiftDropId: 3292 },
      { Level: 25, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 26, RequiredXp: 115, GiftDropId: 3292 },
      { Level: 27, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 28, RequiredXp: 115, GiftDropId: 3292 },
      { Level: 29, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 30, RequiredXp: 115, GiftDropId: 3292 }
    ],
    MatchmakingParams: {
      PreferFullRoomsFrequency: 1,
      PreferEmptyRoomsFrequency: 0
    },
    DailyObjectives: DAILY_OBJECTIVES,
    ConfigTable: [
      { Key: 'Gift.DropChance', Value: '0.5' },
      { Key: 'Gift.XP', Value: '0.5' }
    ],
    PhotonConfig: {
      CloudRegion: process.env.PHOTON_REGION || 'us',
      CrcCheckEnabled: false,
      EnableServerTracingAfterDisconnect: false
    }
  };

  res.json(config);
});

// Amplitude config
router.get('/v1/amplitude', (req, res) => {
  res.json({ AmplitudeKey: 'NoKeyProvided' });
});

// Amplitude config with wildcard
router.get('/v*/amplitude', (req, res) => {
  res.json({ AmplitudeKey: 'NoKeyProvided' });
});

// Config v2 with wildcard
router.all('/v*/', (req, res) => {
  console.log('[Config] GET /v*/ called');
  const config = {
    MessageOfTheDay: 'Welcome to the 7-12-2017 server',
    CdnBaseUri: (() => {
      const proto =
        (req.get('x-forwarded-proto') || '').split(',')[0].trim() ||
        req.protocol || 'http';
      const host = req.get('x-forwarded-host') || req.get('host');
      return host
        ? `${proto}://${host}/cdn/`
        : `http://localhost:${process.env.CDN_PORT || 2058}/`;
    })(),
    LevelProgressionMaps: [
      { Level: 0, RequiredXp: 0, GiftDropId: null },
      { Level: 1, RequiredXp: 10, GiftDropId: 3288 },
      { Level: 2, RequiredXp: 10, GiftDropId: 3293 },
      { Level: 3, RequiredXp: 10, GiftDropId: 3288 },
      { Level: 4, RequiredXp: 20, GiftDropId: 3293 },
      { Level: 5, RequiredXp: 20, GiftDropId: 3288 },
      { Level: 6, RequiredXp: 20, GiftDropId: 3293 },
      { Level: 7, RequiredXp: 20, GiftDropId: 3288 },
      { Level: 8, RequiredXp: 20, GiftDropId: 3293 },
      { Level: 9, RequiredXp: 20, GiftDropId: 3288 },
      { Level: 10, RequiredXp: 20, GiftDropId: 3293 },
      { Level: 11, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 12, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 13, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 14, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 15, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 16, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 17, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 18, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 19, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 20, RequiredXp: 45, GiftDropId: 3293 },
      { Level: 21, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 22, RequiredXp: 115, GiftDropId: 3292 },
      { Level: 23, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 24, RequiredXp: 115, GiftDropId: 3292 },
      { Level: 25, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 26, RequiredXp: 115, GiftDropId: 3292 },
      { Level: 27, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 28, RequiredXp: 115, GiftDropId: 3292 },
      { Level: 29, RequiredXp: 115, GiftDropId: 3293 },
      { Level: 30, RequiredXp: 115, GiftDropId: 3292 }
    ],
    MatchmakingParams: {
      PreferFullRoomsFrequency: 1,
      PreferEmptyRoomsFrequency: 0
    },
    DailyObjectives: DAILY_OBJECTIVES,
    ConfigTable: [
      { Key: 'Gift.DropChance', Value: '0.5' },
      { Key: 'Gift.XP', Value: '0.5' }
    ],
    PhotonConfig: {
      CloudRegion: process.env.PHOTON_REGION || 'us',
      CrcCheckEnabled: false,
      EnableServerTracingAfterDisconnect: false
    }
  };

  res.json(config);
});

module.exports = router;
