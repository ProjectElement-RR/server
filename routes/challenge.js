// /api/challenge/*
//
// Weekly challenges and objective system for 2017
// Based on server.2017M (server.ts) and Rec-Room-Patches 2017/2019 API behavior
// Weekly challenges backported from 2019 (25april2019) since 2017 client has UI for it

const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const { requireAuth, playerIdOf } = require('../lib/auth');

// XP awarded for completing a weekly challenge, and for an objective completion.
const WEEKLY_XP = 500;
const OBJECTIVE_XP = 100;

// Ceiling on any single XP award.
//
// The client sends `additionalXp` and `Complete`, and the previous code added
// them straight into the player's total with no bound - so posting
// { additionalXp: 999999999 } set XP to a billion. Progress endpoints are
// client-reported by nature (there is no gameplay event feed to validate
// against), so the defence is to clamp what one request can be worth rather than
// to pretend the value is trustworthy.
const MAX_XP_PER_REQUEST = 10000;

// Player level curve. Kept here so the two places that compute a level agree.
const XP_PER_LEVEL = 1000;

/**
 * Level implied by a total XP value.
 * @param {number} xp
 * @returns {number}
 */
function levelForXp(xp) {
  return Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1;
}

/**
 * Add XP to a player and recompute their level from the resulting total.
 *
 * The previous statement was `SET xp = xp + ?, level = (xp / 1000) + 1`. SQLite
 * evaluates every assignment against the row as it was *before* the UPDATE, so
 * the stored level was computed from the pre-increment XP and therefore always
 * lagged one award behind.
 *
 * @param {number} playerId
 * @param {number} amount
 * @returns {Promise<{xp:number,level:number,applied:number}>}
 */
async function awardXp(playerId, amount) {
  const applied = Math.max(0, Math.min(Math.floor(amount) || 0, MAX_XP_PER_REQUEST));

  return transaction(async (tx) => {
    const player = await tx.get('SELECT id, xp FROM players WHERE id = ?', [playerId]);
    if (!player) throw new Error('Player not found');

    const newXp = Math.max(0, Number(player.xp || 0) + applied);
    const newLevel = levelForXp(newXp);

    await tx.run('UPDATE players SET xp = ?, level = ? WHERE id = ?', [newXp, newLevel, playerId]);

    return { xp: newXp, level: newLevel, applied };
  });
}

// Daily Challenge IDs from server.2017M (DailyObjectives.ts)
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

// Daily objectives configuration from server.2017M (DailyObjectives.ts)
// Varies by day of week: Sunday=0 ... Saturday=6
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

// Weekly challenge pool (from Rec-Room-Patches 25april2019 weekly_challenges.json)
// Event type 2 = "Complete N games of X"
const WEEKLY_CHALLENGE_POOL = [
  {
    name: "3D Charades",
    description: "Complete 5 games of 3D Charades.",
    event_type: 2,
    count: 5,
    room_locations: [2]
  },
  {
    name: "Disc Golf",
    description: "Complete 5 games of Disc Golf.",
    event_type: 2,
    count: 5,
    room_locations: [3, 4]
  },
  {
    name: "Dodgeball",
    description: "Complete 5 games of Dodgeball.",
    event_type: 2,
    count: 5,
    room_locations: [5]
  },
  {
    name: "Paddleball",
    description: "Complete 5 games of Paddleball.",
    event_type: 2,
    count: 5,
    room_locations: [7]
  },
  {
    name: "Paintball",
    description: "Complete 5 games of Paintball.",
    event_type: 2,
    count: 5,
    room_locations: [8, 9, 10, 11, 12]
  },
  {
    name: "Soccer",
    description: "Complete 5 games of Soccer.",
    event_type: 2,
    count: 5,
    room_locations: [17]
  },
  {
    name: "Bowling",
    description: "Complete 5 games of Bowling.",
    event_type: 2,
    count: 5,
    room_locations: [28]
  },
  {
    name: "Rec Royale Squads",
    description: "Complete 5 games of Rec Royale Squads.",
    event_type: 2,
    count: 5,
    room_locations: [25]
  },
  {
    name: "Rec Royale Solos",
    description: "Complete 5 games of Rec Royale Solos.",
    event_type: 2,
    count: 5,
    room_locations: [26]
  }
];

// Room location to scene GUID mapping (from Rec-Room-Patches 25april2019 weekly_location_scene_guids.json)
const WEEKLY_LOCATION_SCENE_GUIDS = {
  2: "4078dfed-24bb-4db7-863f-578ba48d726b",   // Charades
  3: "f6f7256c-e438-4299-b99e-d20bef8cf7e0",   // Disc Golf 1
  4: "d9378c9f-80bc-46fb-ad1e-1bed8a674f55",   // Disc Golf 2
  5: "3d474b26-26f7-45e9-9a36-9b02847d5e6f",   // Dodgeball
  7: "d89f74fa-d51e-477a-a425-025a891dd499",   // Paddleball
  8: "e122fe98-e7db-49e8-a1b1-105424b6e1f0",   // Paintball 1
  9: "a785267d-c579-42ea-be43-fec1992d1ca7",   // Paintball 2
  10: "ff4c6427-7079-4f59-b22a-69b089420827",  // Paintball 3
  11: "380d18b5-de9c-49f3-80f7-f4a95c1de161",  // Paintball 4
  12: "58763055-2dfb-4814-80b8-16fac5c85709",  // Paintball 5
  17: "6d5eea4b-f069-4ed0-9916-0e2f07df0d03",  // Soccer
  25: "253fa009-6e65-4c90-91a1-7137a56a267f",  // Rec Royale Squads
  26: "b010171f-4875-4e89-baba-61e878cd41e1",  // Rec Royale Solos
  28: "ae929543-9a07-41d5-8ee9-dbbee8c36800",  // Bowling
};

// Get current daily objectives based on day of week (0=Sunday ... 6=Saturday)
function getCurrentDailyObjectives() {
  const dayOfWeek = new Date().getDay();
  const index = dayOfWeek % DAILY_OBJECTIVES.length;
  return DAILY_OBJECTIVES[index];
}

// Get current weekly challenge map (rotates weekly, 3 challenges per week)
// Based on Rec-Room-Patches 25april2019 _weekly_challenge_map logic
function getCurrentWeeklyChallengeMap() {
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const weekStart = now - (now % weekMs);
  const weekNumber = Math.floor(weekStart / weekMs);

  // Select 3 challenges for this week (deterministic based on week number)
  const poolSize = WEEKLY_CHALLENGE_POOL.length;
  const startIndex = weekNumber % poolSize;
  const selectedChallenges = [];

  for (let i = 0; i < 3; i++) {
    const challengeIndex = (startIndex + i) % poolSize;
    selectedChallenges.push(WEEKLY_CHALLENGE_POOL[challengeIndex]);
  }

  const challengeMapId = (weekNumber % 100) + 1;

  return {
    ChallengeMapId: challengeMapId,
    StartAt: weekStart,
    EndAt: weekStart + weekMs,
    ServerTime: now,
    Challenges: selectedChallenges.map((challenge, index) => {
      const challengeId = challengeMapId * 10 + (index + 1);
      return {
        ChallengeId: challengeId,
        Config: JSON.stringify({
          t: challenge.event_type,
          c: challenge.count,
          d: challenge.description,
          n: challenge.name,
          r: challenge.room_locations
        }),
        Tooltip: `${challenge.description} Complete all 3 weekly objectives to earn the skin.`
      };
    }),
    Gifts: [],
    ChallengeThemeString: "Weekly Challenges",
    ChallengeThemeId: 1
  };
}

// Get next week's challenge map (for /getNext endpoint)
function getNextWeeklyChallengeMap() {
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const nextWeekStart = now - (now % weekMs) + weekMs;
  const nextWeekNumber = Math.floor(nextWeekStart / weekMs);

  const poolSize = WEEKLY_CHALLENGE_POOL.length;
  const startIndex = nextWeekNumber % poolSize;
  const selectedChallenges = [];

  for (let i = 0; i < 3; i++) {
    const challengeIndex = (startIndex + i) % poolSize;
    selectedChallenges.push(WEEKLY_CHALLENGE_POOL[challengeIndex]);
  }

  const challengeMapId = (nextWeekNumber % 100) + 1;

  return {
    ChallengeMapId: challengeMapId,
    StartAt: nextWeekStart,
    EndAt: nextWeekStart + weekMs,
    ServerTime: now,
    Challenges: selectedChallenges.map((challenge, index) => {
      const challengeId = challengeMapId * 10 + (index + 1);
      return {
        ChallengeId: challengeId,
        Config: JSON.stringify({
          t: challenge.event_type,
          c: challenge.count,
          d: challenge.description,
          n: challenge.name,
          r: challenge.room_locations
        }),
        Tooltip: `${challenge.description} Complete all 3 weekly objectives to earn the skin.`
      };
    }),
    Gifts: [],
    ChallengeThemeString: "Weekly Challenges",
    ChallengeThemeId: 1
  };
}

// Table creation moved to database.js (ensureObjectiveTables). Creating them
// here at require-time meant a fresh database only gained them once this module
// loaded, so routes/players.js could hit "no such table: player_objectives".
// It was also the source of the schema drift: weekly_progress here declared
// challenge_map_id INTEGER NOT NULL, while an existing database held a TEXT
// challenge_id and no challenge_map_id at all, which made /v*/weekly and
// /v*/updateProgress fail with "no such column" against any pre-existing db.

// Get current challenge - 2017/2019 API format
// Returns JSON string in Message field (matches server.2017M server.ts line 125-142)
router.get('/v1/getCurrent', (req, res) => {
  const challengeMap = getCurrentWeeklyChallengeMap();
  res.json({ Success: true, Message: JSON.stringify(challengeMap) });
});

// Get current challenge with wildcard version support
router.get('/v*/getCurrent', (req, res) => {
  const challengeMap = getCurrentWeeklyChallengeMap();
  res.json({ Success: true, Message: JSON.stringify(challengeMap) });
});

// Get next week's challenge
router.get('/v*/getNext', (req, res) => {
  const challengeMap = getNextWeeklyChallengeMap();
  res.json({ Success: true, Message: JSON.stringify(challengeMap) });
});

// Get daily objectives
router.get('/v1/daily', (req, res) => {
  const objectives = getCurrentDailyObjectives();
  res.json({
    Success: true,
    Objectives: objectives,
    DayOfWeek: new Date().getDay()
  });
});

// Get daily objectives with wildcard version support
router.get('/v*/daily', (req, res) => {
  const objectives = getCurrentDailyObjectives();
  res.json({
    Success: true,
    Objectives: objectives,
    DayOfWeek: new Date().getDay()
  });
});

// Get weekly challenges with player progress.
//
// Requires a session. This previously read the player id from the
// x-rec-room-profile header with no verification and defaulted to player 1, so
// anyone's progress could be read and anyone's could be written.
router.get('/v*/weekly', requireAuth, async (req, res) => {
  const playerId = req.user.id;
  const challengeMap = getCurrentWeeklyChallengeMap();

  try {
    const progress = await all(
      'SELECT challenge_id, progress, completed FROM weekly_progress WHERE player_id = ? AND challenge_map_id = ?',
      [playerId, challengeMap.ChallengeMapId]
    );

    const progressMap = new Map();
    for (const entry of progress) progressMap.set(entry.challenge_id, entry);

    const challengesWithProgress = challengeMap.Challenges.map((challenge) => {
      const record = progressMap.get(challenge.ChallengeId);
      const config = JSON.parse(challenge.Config);
      const count = record ? Number(record.progress || 0) : 0;
      const target = Number(config.c) || 1;

      return {
        ...challenge,
        playerProgress: count,
        completed: Boolean(record && Number(record.completed) === 1),
        percentage: Math.min(100, Math.floor((count / target) * 100))
      };
    });

    return res.json({
      Success: true,
      ChallengeMapId: challengeMap.ChallengeMapId,
      StartAt: challengeMap.StartAt,
      EndAt: challengeMap.EndAt,
      ServerTime: challengeMap.ServerTime,
      Challenges: challengesWithProgress,
      CompleteAll: challengesWithProgress.length > 0 && challengesWithProgress.every((c) => c.completed)
    });
  } catch (err) {
    console.error('[Challenge] weekly failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// Update weekly challenge progress (2019 API format)
// POST /api/challenge/v*/updateProgress
// Body: { ChallengeMapId, ChallengeId, CurrentCount, Complete }
//
// Requires a session. Identity comes from the session, not the header. The
// client-reported `CurrentCount` and `Complete` are clamped so a single request
// cannot grant unbounded XP or skip progress targets.
router.post('/v*/updateProgress', requireAuth, async (req, res) => {
  const playerId = req.user.id;
  const challengeMapId = String(req.body.ChallengeMapId ?? req.body.challengeMapId ?? '');
  const challengeId = Number(req.body.ChallengeId ?? req.body.challengeId);
  const rawCurrentCount = Number(req.body.CurrentCount ?? req.body.currentCount ?? 1);
  const completeFlag = Boolean(req.body.Complete ?? req.body.complete);

  if (!challengeMapId || !Number.isSafeInteger(challengeId) || challengeId <= 0) {
    return res.status(400).json({ error: 'ChallengeMapId and ChallengeId required' });
  }

  // Validate challenge exists in current map
  const challengeMap = getCurrentWeeklyChallengeMap();
  if (String(challengeMap.ChallengeMapId) !== challengeMapId) {
    return res.status(400).json({ error: 'Invalid challenge map' });
  }

  const challenge = challengeMap.Challenges.find((c) => c.ChallengeId === challengeId);
  if (!challenge) {
    return res.status(404).json({ error: 'Challenge not found in current map' });
  }

  const config = JSON.parse(challenge.Config);
  const targetCount = Number(config.c) || 1;

  // Clamp the reported increment. Negative values are ignored.
  const currentCount = Math.max(0, Math.floor(rawCurrentCount) || 0);

  try {
    const row = await get(
      'SELECT * FROM weekly_progress WHERE player_id = ? AND challenge_map_id = ? AND challenge_id = ?',
      [playerId, challengeMapId, challengeId]
    );

    const previousProgress = row ? Number(row.progress || 0) : 0;
    const newProgress = Math.min(targetCount, previousProgress + currentCount);
    const isCompleted = newProgress >= targetCount || (completeFlag && newProgress > 0);
    const completedAt = isCompleted ? new Date().toISOString() : (row?.completed_at || null);
    const wasCompleted = row ? Number(row.completed) === 1 : false;

    if (row) {
      await run(
        'UPDATE weekly_progress SET progress = ?, completed = ?, completed_at = ? WHERE id = ?',
        [newProgress, isCompleted ? 1 : 0, completedAt, row.id]
      );
    } else {
      await run(
        'INSERT INTO weekly_progress (player_id, challenge_map_id, challenge_id, progress, completed, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
        [playerId, challengeMapId, challengeId, newProgress, isCompleted ? 1 : 0, completedAt]
      );
    }

    // XP only on first completion
    let xpReward = 0;
    if (isCompleted && !wasCompleted) {
      const result = await awardXp(playerId, WEEKLY_XP);
      xpReward = result.applied;
    }

    // Check if all challenges completed for skin reward
    const allProgress = await all(
      'SELECT completed FROM weekly_progress WHERE player_id = ? AND challenge_map_id = ?',
      [playerId, challengeMapId]
    );
    const allCompleted = allProgress.length === 3 && allProgress.every((p) => Number(p.completed) === 1);
    if (allCompleted) {
      console.log(`Player ${playerId} completed all weekly challenges! Skin reward eligible.`);
    }

    return res.json({
      Success: true,
      ChallengeId: challengeId,
      CurrentCount: newProgress,
      Complete: isCompleted,
      XPReward: xpReward,
      AllChallengesComplete: allCompleted
    });
  } catch (err) {
    console.error('[Challenge] updateProgress failed:', err.message);
    return res.status(500).json({ error: 'Failed to update progress' });
  }
});

// Complete objective (daily/weekly)
//
// Requires a session. `additionalXp` is clamped to MAX_XP_PER_REQUEST so a
// single request cannot inflate XP arbitrarily. Level is recomputed from the
// new total, not from the old total (the previous `level = (xp / 1000) + 1`
// used the pre-increment xp value due to SQLite's assignment semantics).
router.post('/v1/complete', requireAuth, async (req, res) => {
  const playerId = req.user.id;
  const objectiveType = req.body.objectiveType ?? req.body.ObjectiveType;
  const rawAdditionalXp = Number(req.body.additionalXp ?? req.body.AdditionalXp ?? 0);

  if (!objectiveType) {
    return res.status(400).json({ error: 'Objective type required' });
  }

  try {
    // Award base objective XP + clamped additionalXp
    const totalAward = OBJECTIVE_XP + Math.max(0, Math.floor(rawAdditionalXp) || 0);
    const result = await awardXp(playerId, totalAward);

    // Track objective completion (unique index on (player_id, objective_type) from database.js)
    await run(
      `INSERT INTO player_objectives (player_id, objective_type, completed_count, last_completed_at)
       VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(player_id, objective_type)
       DO UPDATE SET completed_count = completed_count + 1, last_completed_at = datetime('now')`,
      [playerId, objectiveType]
    );

    return res.json({
      Success: true,
      XPReward: result.applied,
      TotalXp: result.xp,
      Level: result.level,
      ObjectiveType: objectiveType
    });
  } catch (err) {
    console.error('[Challenge] complete failed:', err.message);
    return res.status(500).json({ error: 'Failed to complete objective' });
  }
});

// Get player objective progress
//
// Requires a session. A player may only view their own progress. The previous
// version accepted a path parameter and returned any player's objectives.
router.get('/v1/progress', requireAuth, async (req, res) => {
  const playerId = req.user.id;

  try {
    const objectives = await all(
      'SELECT * FROM player_objectives WHERE player_id = ? ORDER BY last_completed_at DESC',
      [playerId]
    );
    return res.json({ Success: true, Objectives: objectives || [] });
  } catch (err) {
    console.error('[Challenge] progress failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch objectives' });
  }
});

module.exports = router;