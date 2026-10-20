// Active room registry.
//
// This was a plain in-memory array. The cluster forks four workers, so each one
// had its own copy: a room created on worker 2 was invisible to the client whose
// next request landed on worker 0, /v2/joinrandom could not find it, the public
// list showed only one worker's rooms, and presence counts disagreed depending
// on which worker answered. Roughly three quarters of multiplayer was broken in
// a way that looked intermittent.
//
// State now lives in SQLite, so every worker reads and writes the same rows.
// Each method is async.
//
// Other defects fixed here:
//   - `players` and `Players` were two parallel arrays every mutation had to
//     keep in sync by hand. There is now one `players` list per room, stored in
//     a join table.
//   - purgeInactiveSessions() deleted rooms that still had players in them once
//     they passed a 10 minute age check, so a long game vanished mid-play.
//     Rooms now expire on last activity, not creation.
//   - findSessionByActivityId() required canJoin(), which is false for every
//     private room, and /v2/create only ever made private rooms. Join-by-random
//     could therefore never match a room that /v2/create had made.
//   - The dorm-room branch called createSession() on every lookup, creating a new
//     room per request with no bound.
//   - roomCodes was a Map that was never pruned, so it grew forever.
//   - Room codes and room ids came from Math.random(), which is not
//     cryptographically random. Codes are guessable and ids collide.
//
// The 2017 client's response shape (getSessionData) is unchanged.

const crypto = require('crypto');
const { db, run, get, all, transaction } = require('../database');

// A room with no activity for this long is removed.
const ROOM_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// How often idle rooms are swept. Runs in the master only.
const PURGE_INTERVAL_MS = 60 * 1000;

const DORM_ROOM_ACTIVITY_ID = '76d98498-60a1-430c-ab76-b54a29b7a163';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

// Broadcast hook, injected by the WebSocket layer to avoid a circular require.
let broadcastFn = null;

/**
 * Register the presence-broadcast callback.
 * @param {(playerId:number) => void} fn
 */
function setBroadcastFn(fn) {
  broadcastFn = fn;
}

// --- schema ---------------------------------------------------------------

/**
 * Create the room tables. Idempotent; safe to call from every worker at boot.
 * @returns {Promise<void>}
 */
async function ensureTables() {
  await run(`CREATE TABLE IF NOT EXISTS active_rooms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     public_id TEXT NOT NULL UNIQUE,
     room_id TEXT,
     activity_id TEXT,
     room_code TEXT,
     room_name TEXT NOT NULL,
     creator_id INTEGER,
     is_private INTEGER NOT NULL DEFAULT 1,
     max_capacity INTEGER NOT NULL DEFAULT 20,
     game_in_progress INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     last_activity_at INTEGER NOT NULL
   )`);

  await run(`CREATE TABLE IF NOT EXISTS active_room_players (
     room_pk INTEGER NOT NULL,
     player_id INTEGER NOT NULL,
     joined_at INTEGER NOT NULL,
     PRIMARY KEY (room_pk, player_id),
     FOREIGN KEY (room_pk) REFERENCES active_rooms(id) ON DELETE CASCADE
   )`);

  // Room codes must be unique but several rooms legitimately have none.
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_active_rooms_code ON active_rooms(room_code) WHERE room_code IS NOT NULL');
  await run('CREATE INDEX IF NOT EXISTS idx_active_rooms_activity ON active_rooms(activity_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_active_rooms_idle ON active_rooms(last_activity_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_room_players_player ON active_room_players(player_id)');
}

// --- helpers ---------------------------------------------------------------

/**
 * Generate an unguessable room code.
 *
 * Draws from crypto.randomInt rather than Math.random, and retries on the
 * (astronomically unlikely) collision, because the column is uniquely indexed.
 *
 * @returns {Promise<string>}
 */
async function generateRoomCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
    }
    // eslint-disable-next-line no-await-in-loop
    const clash = await get('SELECT 1 AS hit FROM active_rooms WHERE room_code = ?', [code]);
    if (!clash) return code;
  }
  // Fall back to a longer code rather than looping forever.
  return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
}

/**
 * Random opaque room identifier.
 * @returns {string}
 */
function generateRoomId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Hydrate a room row plus its player list into a plain object.
 *
 * @param {object} row active_rooms row
 * @param {number[]} playerIds
 * @returns {object}
 */
function hydrate(row, playerIds) {
  return {
    id: row.id,
    publicId: row.public_id,
    activityId: row.activity_id,
    roomCode: row.room_code,
    roomId: row.room_id || generateRoomId(),
    roomName: row.room_name,
    creatorId: row.creator_id,
    isPrivate: Boolean(row.is_private),
    maxCapacity: row.max_capacity,
    gameInProgress: Boolean(row.game_in_progress),
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    players: playerIds
  };
}

/**
 * Load a room by primary key.
 * @param {number} pk
 * @returns {Promise<object|null>}
 */
async function loadRoom(pk) {
  const row = await get('SELECT * FROM active_rooms WHERE id = ?', [pk]);
  if (!row) return null;
  const players = await all(
    'SELECT player_id FROM active_room_players WHERE room_pk = ? ORDER BY joined_at ASC',
    [pk]
  );
  return hydrate(row, players.map((p) => Number(p.player_id)));
}

// --- public API ------------------------------------------------------------

/**
 * Create a room.
 *
 * @param {string|null} activityId
 * @param {boolean} [isPrivate=true]
 * @param {number|null} [creatorId]
 * @param {{roomName?:string, roomCode?:string, maxCapacity?:number}} [options]
 * @returns {Promise<object>} the new room
 */
async function createSession(activityId, isPrivate = true, creatorId = null, options = {}) {
  await ensureTables();

  const now = Date.now();
  const publicId = crypto.randomBytes(8).toString('hex');
  const roomCode = options.roomCode || null;

  const result = await run(
    `INSERT INTO active_rooms
       (public_id, room_id, activity_id, room_code, room_name, creator_id,
        is_private, max_capacity, game_in_progress, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      publicId,
      generateRoomId(),
      activityId || null,
      roomCode,
      options.roomName || 'Rec Room Session',
      creatorId,
      isPrivate ? 1 : 0,
      options.maxCapacity || 20,
      now,
      now
    ]
  );

  return loadRoom(result.lastID);
}

/**
 * Create a room with a freshly generated shareable code.
 * @param {string|null} activityId
 * @param {boolean} [isPrivate]
 * @param {number|null} [creatorId]
 * @returns {Promise<object>}
 */
async function createSessionWithCode(activityId, isPrivate, creatorId) {
  const roomCode = await generateRoomCode();
  return createSession(activityId, isPrivate, creatorId, { roomCode });
}

/**
 * Find a joinable room for the given activities, creating one if none exists.
 *
 * Only public rooms are eligible for a random join. Previously this also called
 * canJoin(), which excluded every private room - and since /v2/create only
 * produced private rooms, a random join could never match one.
 *
 * @param {string|string[]} activityIds
 * @param {number|null} creatorId
 * @returns {Promise<object>}
 */
async function findSessionByActivityId(activityIds, creatorId = null) {
  await ensureTables();

  const targets = (Array.isArray(activityIds) ? activityIds : [activityIds]).filter(
    (id) => typeof id === 'string' && id.length > 0
  );

  for (const targetId of targets) {
    // Dorm rooms are always private and only reachable by code, never matched
    // here - previously this created a brand new room on every single lookup.
    if (targetId === DORM_ROOM_ACTIVITY_ID) continue;

    // eslint-disable-next-line no-await-in-loop
    const candidates = await all(
      `SELECT id FROM active_rooms
        WHERE activity_id = ? AND is_private = 0
        ORDER BY last_activity_at DESC LIMIT 10`,
      [targetId]
    );

    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const room = await loadRoom(candidate.id);
      if (room && room.players.length < room.maxCapacity) return room;
    }
  }

  const activityId = targets.length ? targets[Math.floor(Math.random() * targets.length)] : null;
  return createSession(activityId, false, creatorId);
}

/**
 * Look up a room by its share code.
 * @param {string} roomCode
 * @returns {Promise<object|null>}
 */
async function findSessionByRoomCode(roomCode) {
  if (typeof roomCode !== 'string' || roomCode.length === 0) return null;
  await ensureTables();

  const normalised = roomCode.trim().toUpperCase();
  const row = await get('SELECT id FROM active_rooms WHERE room_code = ?', [normalised]);
  return row ? loadRoom(row.id) : null;
}

/**
 * Look up a room by the id handed to the client.
 *
 * Accepts the public hex id or the numeric primary key, because the client
 * echoes back whatever it was given and the two used to be the same value in
 * one code path and different values in another.
 *
 * @param {string|number} identifier
 * @returns {Promise<object|null>}
 */
async function findSessionByPublicId(identifier) {
  if (identifier === undefined || identifier === null) return null;
  await ensureTables();

  const text = String(identifier).trim();
  if (!text) return null;

  const row =
    (await get('SELECT id FROM active_rooms WHERE public_id = ?', [text])) ||
    (/^\d+$/.test(text)
      ? await get('SELECT id FROM active_rooms WHERE id = ?', [Number(text)])
      : null);

  return row ? loadRoom(row.id) : null;
}

/**
 * Add a player to a room.
 *
 * A player occupies at most one room: any previous membership is removed first.
 * Uses INSERT OR IGNORE so a repeated join is a no-op rather than a duplicate
 * entry, and an IMMEDIATE transaction so two concurrent joins cannot both pass
 * the capacity check.
 *
 * @param {number} playerId
 * @param {object} room
 * @returns {Promise<object>} the room, with the player in it
 */
async function joinSession(playerId, room) {
  const id = Number(playerId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('joinSession requires a positive player id');

  await disconnectPlayer(id);
  const now = Date.now();

  await transaction(async (tx) => {
    const current = await tx.get('SELECT * FROM active_rooms WHERE id = ?', [room.id]);
    if (!current) throw new Error('Room no longer exists');

    const occupants = await tx.all('SELECT player_id FROM active_room_players WHERE room_pk = ?', [
      room.id
    ]);

    if (occupants.length >= current.max_capacity) {
      throw new Error('Room is full');
    }

    await tx.run(
      'INSERT OR IGNORE INTO active_room_players (room_pk, player_id, joined_at) VALUES (?, ?, ?)',
      [room.id, id, now]
    );
    await tx.run('UPDATE active_rooms SET last_activity_at = ? WHERE id = ?', [now, room.id]);
  });

  const updated = await loadRoom(room.id);

  if (broadcastFn) {
    broadcastFn(id);
    for (const otherId of updated.players) {
      if (otherId !== id) broadcastFn(otherId);
    }
  }

  return updated;
}

/**
 * Remove a player from whichever room they are in.
 * @param {number} playerId
 * @returns {Promise<number>} rooms vacated
 */
async function disconnectPlayer(playerId) {
  const id = Number(playerId);
  if (!Number.isSafeInteger(id) || id <= 0) return 0;

  await ensureTables();
  const rows = await all('SELECT room_pk FROM active_room_players WHERE player_id = ?', [id]);
  if (!rows.length) return 0;

  const now = Date.now();
  for (const row of rows) {
    await run('DELETE FROM active_room_players WHERE room_pk = ? AND player_id = ?', [
      row.room_pk,
      id
    ]);
    await run('UPDATE active_rooms SET last_activity_at = ? WHERE id = ?', [now, row.room_pk]);
  }
  return rows.length;
}

/**
 * The room a player currently occupies.
 * @param {number} playerId
 * @returns {Promise<object|null>}
 */
async function findPlayerSession(playerId) {
  const id = Number(playerId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const row = await get('SELECT room_pk FROM active_room_players WHERE player_id = ? LIMIT 1', [id]);
  return row ? loadRoom(row.room_pk) : null;
}

/**
 * Apply changes to a room.
 *
 * The caller is responsible for authorising the change; this only enforces
 * shape and bounds.
 *
 * @param {string|number} identifier
 * @param {{Private?:boolean, Name?:string, MaxCapacity?:number, InProgress?:boolean}} mods
 * @returns {Promise<boolean>} whether a room was updated
 */
async function modifySession(identifier, mods) {
  const room = await findSessionByPublicId(identifier);
  if (!room) return false;

  const sets = [];
  const params = [];

  if (typeof mods.Private === 'boolean') {
    sets.push('is_private = ?');
    params.push(mods.Private ? 1 : 0);
  }
  if (typeof mods.Name === 'string' && mods.Name.trim()) {
    sets.push('room_name = ?');
    params.push(mods.Name.trim().slice(0, 64));
  }
  if (mods.MaxCapacity !== undefined) {
    const capacity = Number.parseInt(mods.MaxCapacity, 10);
    if (Number.isSafeInteger(capacity) && capacity > 0) {
      sets.push('max_capacity = ?');
      params.push(Math.min(capacity, 500));
    }
  }
  if (typeof mods.InProgress === 'boolean') {
    sets.push('game_in_progress = ?');
    params.push(mods.InProgress ? 1 : 0);
  }

  if (!sets.length) return true;

  sets.push('last_activity_at = ?');
  params.push(Date.now(), room.id);

  await run(`UPDATE active_rooms SET ${sets.join(', ')} WHERE id = ?`, params);
  return true;
}

/**
 * Assign a share code to a room, rejecting a code that is already in use.
 * @param {string} roomCode
 * @param {string|number} identifier
 * @returns {Promise<boolean>}
 */
async function setRoomCode(roomCode, identifier) {
  const room = await findSessionByPublicId(identifier);
  if (!room || typeof roomCode !== 'string' || !roomCode.trim()) return false;

  const normalised = roomCode.trim().toUpperCase();
  const clash = await get('SELECT id FROM active_rooms WHERE room_code = ? AND id != ?', [
    normalised,
    room.id
  ]);
  if (clash) return false;

  await run('UPDATE active_rooms SET room_code = ? WHERE id = ?', [normalised, room.id]);
  return true;
}

/**
 * Render a room in the shape the 2017 client parses.
 * @param {object} room
 * @returns {object}
 */
function getSessionData(room) {
  return {
    GameSessionId: room.publicId,
    RegionId: 'us',
    RoomId: room.roomId,
    CreatorPlayerId: room.creatorId,
    Name: room.roomName,
    ActivityLevelId: room.activityId || '',
    Private: room.isPrivate,
    GameInProgress: room.gameInProgress,
    MaxCapacity: room.maxCapacity,
    IsFull: room.players.length >= room.maxCapacity,
    Players: room.players.map(Number),
    RoomCode: room.roomCode || ''
  };
}

/**
 * Every room visible in the public list.
 * @returns {Promise<object[]>}
 */
async function getPublicSessions() {
  await ensureTables();
  const rows = await all(
    'SELECT id FROM active_rooms WHERE is_private = 0 AND creator_id IS NOT NULL ORDER BY last_activity_at DESC LIMIT 200'
  );

  const sessions = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const room = await loadRoom(row.id);
    if (room) sessions.push(getSessionData(room));
  }
  return sessions;
}

/**
 * Remove rooms with no members and no recent activity.
 *
 * The previous version dropped any room older than ten minutes *even when
 * players were still in it*, so a game in progress disappeared from under its
 * participants. Expiry is now based on last activity and empty rooms only.
 *
 * @returns {Promise<number>} rooms removed
 */
async function purgeInactiveSessions() {
  await ensureTables();
  const cutoff = Date.now() - ROOM_IDLE_TIMEOUT_MS;

  const result = await run(
    `DELETE FROM active_rooms
      WHERE last_activity_at < ?
        AND id NOT IN (SELECT room_pk FROM active_room_players)`,
    [cutoff]
  );

  if (result.changes > 0) {
    console.log(`[SessionManager] Purged ${result.changes} idle rooms`);
  }
  return result.changes;
}

let purgeInterval = null;

/**
 * Start the idle-room sweep. Master process only.
 * @returns {NodeJS.Timeout|null}
 */
function startPurgeScheduler() {
  if (purgeInterval) return purgeInterval;
  purgeInterval = setInterval(() => {
    purgeInactiveSessions().catch((err) => console.error('[SessionManager] Purge failed:', err.message));
  }, PURGE_INTERVAL_MS);
  return purgeInterval;
}

/** @returns {void} */
function stopPurgeScheduler() {
  if (!purgeInterval) return;
  clearInterval(purgeInterval);
  purgeInterval = null;
}

module.exports = {
  setBroadcastFn,
  ensureTables,
  createSession,
  createSessionWithCode,
  findSessionByActivityId,
  findSessionByRoomCode,
  findSessionByPublicId,
  findPlayerSession,
  joinSession,
  disconnectPlayer,
  modifySession,
  setRoomCode,
  generateRoomCode,
  generateRoomId,
  getSessionData,
  getPublicSessions,
  purgeInactiveSessions,
  startPurgeScheduler,
  stopPurgeScheduler,
  DORM_ROOM_ACTIVITY_ID
};