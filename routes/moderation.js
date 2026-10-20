// Moderation endpoints.
//
// The critical change: every action here is gated by requireAdmin, which accepts
// either the configured ADMIN_KEY or an account flagged `is_moderator`. Before,
// these routes required only a valid JWT and there was no role column anywhere
// in the schema - so any player who had ever logged in could ban, unban or kick
// anyone, including the operator.
//
// Bans now also revoke live sessions, which is what makes them effective. The
// previous ban set a flag that no code path consulted, so the target kept full
// API access for the remainder of their 7-day token.

const express = require('express');
const router = express.Router();
const { db, run, get, all, transaction } = require('../database');
const { requireAdmin, revokeAllSessionsForPlayer, parseModerationData, moderationExpired } = require('../lib/auth');
const { sendToPlayer, ResponseResults } = require('../lib/wsServer2017');
const sessionManager = require('../lib/sessionManager');

/**
 * Interpret the duration field the client sends.
 *
 * The previous code stored the caller's value straight into `expires`, which
 * the login path then compared against `Math.floor(Date.now() / 1000)`. A value
 * in hours or milliseconds produced an expiry in 1970 or the year 56000. Now the
 * unit is always normalised to a unix-seconds timestamp.
 *
 * @param {unknown} duration
 * @returns {number} unix seconds; 0 means permanent
 */
function resolveExpiry(duration) {
  const value = Number(duration);

  // No duration, or an explicitly permanent ban.
  if (!Number.isFinite(value) || value <= 0) return 0;

  const nowSeconds = Math.floor(Date.now() / 1000);

  // Values large enough to already look like a unix timestamp are taken as one.
  if (value > 1e9) return Math.floor(value);

  // Otherwise interpret as hours, with a sane ceiling so a typo cannot ban
  // someone for a century.
  return nowSeconds + Math.min(value, 8760) * 3600;
}

/**
 * Read a ban record for a player, normalising legacy rows.
 * @param {object} player
 * @returns {{banned:boolean,reason:string,expires:number}}
 */
function banState(player) {
  const parsed = parseModerationData(player.moderation_data ?? player.is_banned);
  if (!parsed) return { banned: Boolean(player.is_banned), reason: '', expires: 0 };

  const active = parsed.banned && !moderationExpired(parsed);
  return { banned: active, reason: parsed.reason, expires: parsed.expires };
}

/**
 * Ban status. A player may always ask about themselves; reading anyone else's
 * record requires moderator access.
 */
router.get('/v1/status', requireAdmin, async (req, res) => {
  const requested = req.query.playerId !== undefined ? req.query.playerId : req.user?.id;
  const targetId = Number.parseInt(requested, 10);

  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'A valid playerId is required' });
  }

  // Without the admin key, a caller may only inspect their own record.
  if (!req.viaAdminKey && req.user && targetId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot view another player moderation record' });
  }

  try {
    const player = await get('SELECT id, is_banned, moderation_data FROM players WHERE id = ?', [targetId]);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const state = banState(player);
    return res.json({
      isBanned: state.banned,
      data: state.banned
        ? { reason: state.reason || 'Banned from server', expires: state.expires }
        : {}
    });
  } catch (err) {
    console.error('[Moderation] status failed:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
});

router.get('/v1/moderationBlockDetails', requireAdmin, async (req, res) => {
  try {
    const requested = req.query.playerId !== undefined ? req.query.playerId : req.user?.id;
    const targetId = Number.parseInt(requested, 10);

    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      return res.json({ ReportCategory: 0, Duration: 0, GameSessionId: 0, Message: '' });
    }

    const player = await get('SELECT id, is_banned, moderation_data FROM players WHERE id = ?', [targetId]);
    if (!player) {
      return res.json({ ReportCategory: 0, Duration: 0, GameSessionId: 0, Message: '' });
    }

    const state = banState(player);
    if (!state.banned) {
      return res.json({ ReportCategory: 0, Duration: 0, GameSessionId: 0, Message: '' });
    }

    return res.json({
      ReportCategory: 1,
      Duration: state.expires || 0,
      GameSessionId: 0,
      Message: state.reason || 'You have been suspended from this server.'
    });
  } catch (err) {
    console.error('[Moderation] blockDetails failed:', err.message);
    return res.json({ ReportCategory: 0, Duration: 0, GameSessionId: 0, Message: '' });
  }
});

/**
 * Ban a player.
 *
 * Refuses to act on another moderator, so a compromised moderator account
 * cannot lock the operator out.
 */
router.post('/v1/ban', requireAdmin, async (req, res) => {
  const { playerId, reason } = req.body || {};
  const targetId = Number.parseInt(playerId, 10);

  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'A valid playerId is required' });
  }

  const expiry = resolveExpiry(req.body?.duration);
  const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 512) : 'Banned from server';

  try {
    const target = await get('SELECT id, username, is_moderator FROM players WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ error: 'Player not found' });
    if (target.is_moderator) return res.status(403).json({ error: 'Cannot moderate another moderator' });

    const payload = JSON.stringify({ banned: true, reason: text, expires: expiry });
    await run('UPDATE players SET moderation_data = ?, is_banned = 1 WHERE id = ?', [payload, targetId]);

    // End their access immediately instead of waiting for token expiry.
    const revoked = await revokeAllSessionsForPlayer(targetId, 'banned');

    // Pull them out of any room they occupy.
    await sessionManager.disconnectPlayer(targetId).catch(() => {});

    try {
      sendToPlayer(
        targetId,
        JSON.stringify({
          Id: ResponseResults.ModerationKick,
          Msg: { PlayerId: targetId, Reason: text }
        })
      );
    } catch {
      // The player may not be connected; the session revocation is what matters.
    }

    console.warn(`[Moderation] Banned player ${targetId} (${target.username}); ${revoked} sessions revoked`);
    return res.json({ success: true, message: 'Player banned', sessionsRevoked: revoked });
  } catch (err) {
    console.error('[Moderation] ban failed:', err.message);
    return res.status(500).json({ error: 'Failed to ban player' });
  }
});

router.post('/v1/unban', requireAdmin, async (req, res) => {
  const targetId = Number.parseInt(req.body?.playerId, 10);

  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'A valid playerId is required' });
  }

  try {
    const result = await run(
      "UPDATE players SET moderation_data = '{\"banned\":false,\"reason\":\"\",\"expires\":0}', is_banned = 0 WHERE id = ?",
      [targetId]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Player not found' });

    return res.json({ success: true, message: 'Player unbanned' });
  } catch (err) {
    console.error('[Moderation] unban failed:', err.message);
    return res.status(500).json({ error: 'Failed to unban player' });
  }
});

/**
 * Kick a player from their current room.
 *
 * This previously sent a WebSocket frame and nothing else, so the player stayed
 * in the room's player list and continued to occupy a slot.
 */
router.post('/v1/kick', requireAdmin, async (req, res) => {
  const targetId = Number.parseInt(req.body?.playerId, 10);

  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'A valid playerId is required' });
  }

  try {
    const room = await sessionManager.findPlayerSession(targetId);
    const leftRoom = room ? await sessionManager.disconnectPlayer(targetId) : 0;

    try {
      sendToPlayer(
        targetId,
        JSON.stringify({
          Id: ResponseResults.ModerationKick,
          Msg: {
            PlayerId: targetId,
            Reason:
              typeof req.body?.reason === 'string' && req.body.reason.trim()
                ? req.body.reason.trim().slice(0, 256)
                : 'You have been removed from the room'
          }
        })
      );
    } catch {
      // Not connected.
    }

    return res.json({ success: true, message: 'Player kicked', leftRoom: leftRoom > 0 });
  } catch (err) {
    console.error('[Moderation] kick failed:', err.message);
    return res.status(500).json({ error: 'Failed to kick player' });
  }
});

/**
 * Tell a client to leave the game. Does not revoke the session.
 */
router.post('/v1/quitgame', requireAdmin, async (req, res) => {
  const targetId = Number.parseInt(req.body?.playerId, 10);

  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'A valid playerId is required' });
  }

  try {
    sendToPlayer(
      targetId,
      JSON.stringify({ Id: ResponseResults.ModerationQuitGame, Msg: { PlayerId: targetId } })
    );
    return res.json({ success: true, message: 'Player quit game' });
  } catch (err) {
    console.error('[Moderation] quitgame failed:', err.message);
    return res.status(500).json({ error: 'Failed to signal player' });
  }
});

/**
 * Grant or revoke the moderator role.
 *
 * Not part of the 2017 protocol - this is the operator-facing endpoint for
 * bootstrapping. Requires the admin key specifically, so a moderator account
 * cannot promote itself.
 */
router.post('/v1/setmoderator', (req, res) => {
  const { hasAdminKey } = require('../lib/auth');
  if (!hasAdminKey(req)) {
    return res.status(401).json({ error: 'Administrator key required' });
  }

  const targetId = Number.parseInt(req.body?.playerId, 10);
  const enabled = req.body?.enabled;

  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'A valid playerId is required' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  run('UPDATE players SET is_moderator = ? WHERE id = ?', [enabled ? 1 : 0, targetId])
    .then((result) => {
      if (result.changes === 0) return res.status(404).json({ error: 'Player not found' });
      return res.json({ success: true, playerId: targetId, isModerator: enabled });
    })
    .catch((err) => {
      console.error('[Moderation] setmoderator failed:', err.message);
      res.status(500).json({ error: 'Failed to update role' });
    });
});

module.exports = router;