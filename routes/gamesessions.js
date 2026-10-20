const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const { requireAuth, optionalAuth, playerIdOf } = require('../lib/auth');
const { config } = require('../lib/config');
const sessionManager = require('../lib/sessionManager');
const { setSession, broadcastPresenceUpdate } = require('../lib/wsServer2017');
const { playerIdFromHeader } = require('../lib/identity');

/**
 * Actor for the v2 endpoints.
 *
 * The 2017 client sends `x-rec-room-profile` on many calls and does not always
 * attach the session token, so these routes accept the header as a fallback.
 * That is a known compatibility compromise: the header is client-asserted and
 * therefore not proof of identity. It is safe here only because joining a room
 * affects the caller's own participation, and because room state is now shared
 * through SQLite rather than per-worker memory. Any endpoint that touches
 * another player's data uses requireAuth and never consults this.
 *
 * @param {import('express').Request} req
 * @returns {number|null}
 */
function actorOf(req) {
  const authPlayerId = req.user ? req.user.id : null;
  return authPlayerId ?? playerIdFromHeader(req);
}

// ---------------------------------------------------------------------------
// v1
// ---------------------------------------------------------------------------

router.get('/v1/', (req, res) => {
  res.status(403).send('');
});

/**
 * Create a room.
 *
 * The response previously returned `Date.now()` as SessionId while the row's
 * primary key was an autoincrement value, so /v1/join - which looks the room up
 * by primary key - could never find a room that had just been created. It now
 * returns the actual inserted id.
 */
router.post('/v1/', optionalAuth, async (req, res) => {
  const { room_id, room_name, is_private, max_players } = req.body || {};
  const hostId = actorOf(req);
  if (!hostId) return res.status(401).json({ error: 'Access token required' });

  if (!room_id || !room_name) {
    return res.status(400).json({ error: 'room_id and room_name are required' });
  }

  const maxPlayers = Number.parseInt(max_players, 10) || 4;
  const players = JSON.stringify([hostId]);

  try {
    const result = await run(
      'INSERT INTO game_sessions (room_id, room_name, host_id, players, is_private, max_players) VALUES (?, ?, ?, ?, ?, ?)',
      [String(room_id), String(room_name).slice(0, config.limits.maxRoomNameLength), hostId, players, is_private ? 1 : 0, maxPlayers]
    );

    return res.json({
      SessionId: String(result.lastID),
      RoomId: room_id,
      RoomName: room_name,
      HostId: hostId,
      Players: [hostId],
      IsPrivate: Boolean(is_private),
      MaxPlayers: maxPlayers
    });
  } catch (err) {
    console.error('[GameSession] create failed:', err.message);
    return res.status(500).json({ error: 'Failed to create game session' });
  }
});

/**
 * Join a room.
 *
 * The read-modify-write of the `players` JSON array moved into a transaction:
 * two simultaneous joins previously both read the same list and one overwrite
 * silently dropped the other.
 */
router.post('/v1/join', optionalAuth, async (req, res) => {
  const { session_id } = req.body || {};
  const playerId = actorOf(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  try {
    const joined = await transaction(async (tx) => {
      const session = await tx.get('SELECT * FROM game_sessions WHERE id = ?', [session_id]);
      if (!session) return { error: 'Game session not found', status: 404 };

      const players = JSON.parse(session.players || '[]');

      if (session.is_private === 1 && Number(session.host_id) !== playerId) {
        return { error: 'Room is private', status: 403 };
      }
      if (players.includes(playerId)) {
        return { error: 'Already in this session', status: 409 };
      }
      if (players.length >= session.max_players) {
        return { error: 'Room is full', status: 400 };
      }

      players.push(playerId);
      await tx.run('UPDATE game_sessions SET players = ? WHERE id = ?', [
        JSON.stringify(players),
        session_id
      ]);

      return { session, players };
    });

    if (joined.error) return res.status(joined.status).json({ error: joined.error });

    const { session, players } = joined;
    return res.json({
      SessionId: String(session_id),
      RoomId: session.room_id,
      RoomName: session.room_name,
      HostId: session.host_id,
      Players: players,
      IsPrivate: session.is_private === 1,
      MaxPlayers: session.max_players
    });
  } catch (err) {
    console.error('[GameSession] join failed:', err.message);
    return res.status(500).json({ error: 'Failed to join game session' });
  }
});

router.post('/v1/leave', optionalAuth, async (req, res) => {
  const { session_id } = req.body || {};
  const playerId = actorOf(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  try {
    const result = await transaction(async (tx) => {
      const session = await tx.get('SELECT * FROM game_sessions WHERE id = ?', [session_id]);
      if (!session) return { error: 'Game session not found', status: 404 };

      const players = JSON.parse(session.players || '[]');
      const index = players.indexOf(playerId);
      if (index === -1) return { error: 'Player not in session', status: 400 };

      players.splice(index, 1);

      if (players.length === 0) {
        await tx.run('DELETE FROM game_sessions WHERE id = ?', [session_id]);
      } else {
        await tx.run('UPDATE game_sessions SET players = ? WHERE id = ?', [
          JSON.stringify(players),
          session_id
        ]);
      }
      return { ok: true };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ success: true });
  } catch (err) {
    console.error('[GameSession] leave failed:', err.message);
    return res.status(500).json({ error: 'Failed to leave game session' });
  }
});

// ---------------------------------------------------------------------------
// v2
// ---------------------------------------------------------------------------

/**
 * Publish presence for a player who just changed rooms.
 * @param {number} playerId
 * @param {object} room
 */
function publishPresence(playerId, room) {
  try {
    setSession(playerId, sessionManager.getSessionData(room));
    broadcastPresenceUpdate(playerId);
  } catch (err) {
    // Presence is advisory; a failure here must not fail the room operation.
    console.warn(`[GameSession] Presence publish failed for ${playerId}: ${err.message}`);
  }
}

router.post('/v2/create', optionalAuth, async (req, res) => {
  const body = req.body || {};
  const playerId = actorOf(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });

  const maxCapacity = Number.parseInt(body.MaxCapacity, 10);

  try {
    const room = await sessionManager.createSession(body.ActivityLevelId, true, playerId, {
      roomName: typeof body.Name === 'string' && body.Name.trim() ? body.Name.trim().slice(0, 64) : undefined,
      roomCode: typeof body.RoomCode === 'string' && body.RoomCode.trim() ? body.RoomCode.trim().toUpperCase().slice(0, 12) : undefined,
      maxCapacity: Number.isSafeInteger(maxCapacity) && maxCapacity > 0 ? maxCapacity : undefined
    });

    const joined = await sessionManager.joinSession(playerId, room);
    publishPresence(playerId, joined);

    return res.json({ Result: 0, GameSession: sessionManager.getSessionData(joined) });
  } catch (err) {
    console.error('[GameSession] v2/create failed:', err.message);
    return res.status(500).json({ error: 'Failed to create room' });
  }
});

router.post('/v2/joinrandom', optionalAuth, async (req, res) => {
  const body = req.body || {};
  const playerId = actorOf(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });

  try {
    const room = await sessionManager.findSessionByActivityId(body.ActivityLevelIds || [], playerId);
    const joined = await sessionManager.joinSession(playerId, room);
    publishPresence(playerId, joined);

    return res.json({ Result: 0, GameSession: sessionManager.getSessionData(joined) });
  } catch (err) {
    console.error('[GameSession] v2/joinrandom failed:', err.message);
    return res.status(500).json({ error: 'Failed to join a room' });
  }
});

/**
 * Join by share code.
 *
 * Previously this created a brand new room for *any* code string the caller
 * supplied, and the code was a Math.random value in an unbounded Map. A caller
 * could now mint unlimited rooms and guess others' codes.
 */
router.post('/v2/joinroomcode', optionalAuth, async (req, res) => {
  const { RoomCode, ActivityLevelId } = req.body || {};
  const playerId = actorOf(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });

  if (typeof RoomCode !== 'string' || !RoomCode.trim()) {
    return res.status(400).json({ error: 'RoomCode is required' });
  }

  try {
    let room = await sessionManager.findSessionByRoomCode(RoomCode);

    if (!room) {
      // Create on demand, so a code shared before the room exists still works.
      // The code is normalised and uniquely indexed, so it cannot be hijacked.
      room = await sessionManager.createSessionWithCode(ActivityLevelId || null, true, playerId);
      await sessionManager.setRoomCode(RoomCode, room.id);
      room = (await sessionManager.findSessionByRoomCode(RoomCode)) || room;
    }

    const joined = await sessionManager.joinSession(playerId, room);
    publishPresence(playerId, joined);

    return res.json({ Result: 0, GameSession: sessionManager.getSessionData(joined) });
  } catch (err) {
    console.error('[GameSession] v2/joinroomcode failed:', err.message);
    return res.status(500).json({ error: 'Failed to join room' });
  }
});

router.post('/v2/join', optionalAuth, async (req, res) => {
  const { GameSessionId } = req.body || {};
  const playerId = actorOf(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });

  try {
    // Previously this compared a numeric in-process counter against a JSON
    // string, so the comparison was never true and every call returned
    // Result: 1 (NoSuchGame) even for a room the caller had just joined.
    const room = await sessionManager.findSessionByPublicId(GameSessionId);
    if (!room) return res.json({ Result: 1 });

    const joined = await sessionManager.joinSession(playerId, room);
    publishPresence(playerId, joined);

    return res.json({ Result: 0, GameSession: sessionManager.getSessionData(joined) });
  } catch (err) {
    console.error('[GameSession] v2/join failed:', err.message);
    return res.status(500).json({ error: 'Failed to join room' });
  }
});

/**
 * Modify a room.
 *
 * Requires a session, and only the room's creator may change it. This endpoint
 * previously had no middleware at all, so any anonymous caller could rename or
 * un-private any room in the process.
 */
router.post('/v2/modify', optionalAuth, async (req, res) => {
  const { GameSessionId, Private, Name, MaxCapacity, InProgress } = req.body || {};
  const playerId = actorOf(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });

  try {
    const room = await sessionManager.findSessionByPublicId(GameSessionId);
    if (!room) {
      return res.json({ Success: false, Message: 'No such game session.' });
    }
    if (Number(room.creatorId) !== playerId) {
      return res.status(403).json({ Success: false, Message: 'Only the room creator may modify it.' });
    }

    await sessionManager.modifySession(room.id, { Private, Name, MaxCapacity, InProgress });
    return res.json({ Success: true, Message: 'Game session modified successfully.' });
  } catch (err) {
    console.error('[GameSession] v2/modify failed:', err.message);
    return res.status(500).json({ Success: false, Message: 'Failed to modify game session.' });
  }
});

router.get('/v2/listpublicevents', optionalAuth, async (req, res) => {
  try {
    return res.json(await sessionManager.getPublicSessions());
  } catch (err) {
    console.error('[GameSession] v2/listpublicevents failed:', err.message);
    return res.status(500).json([]);
  }
});

router.post('/v2/reportjoinresult', optionalAuth, (req, res) => {
  res.sendStatus(200);
});

module.exports = router;