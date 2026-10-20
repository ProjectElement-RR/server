// Client-asserted identity.
//
// The 2017 Unity client sends `x-rec-room-profile: <playerId>` on a lot of
// requests, and on many of them it does *not* also send the session token. Those
// routes need a value, so the header is used as a fallback.
//
// A header is not proof of identity - any client can set it to any id. That is
// why it is confined to this one module rather than being read ad hoc in route
// handlers, and why:
//
//   * every endpoint that reads or writes *another player's* data uses
//     requireAuth from lib/auth.js and never touches this file;
//   * this is only used for self-service operations (joining a room you are
//     about to occupy, asking for your own avatar).
//
// The value is still validated: it must be a positive integer naming a player
// that exists. Returning null rather than a guess means callers fail closed.
//
// If the client is ever modified or wrapped so it can send the token
// everywhere, this file and its call sites can be deleted in one pass.

const { db, run, get, all, transaction } = require('../database');

/** @type {Map<string, Promise<number|null>>} */
const existenceCache = new Map();

/** How long a resolved id stays cached, to keep this from hitting SQLite per request. */
const CACHE_TTL_MS = 30e3;

/**
 * Drop the existence cache. Call after a player is created or deleted.
 * @returns {void}
 */
function clearCache() {
  existenceCache.clear();
}

/**
 * The player id asserted by the request headers, if it names a real player.
 *
 * @param {import('express').Request} req
 * @returns {number|null}
 */
function playerIdFromHeader(req) {
  const raw =
    req.headers?.['x-rec-room-profile'] ??
    req.headers?.['X-Rec-Room-Profile'] ??
    null;

  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== 'string' && typeof first !== 'number') return null;

  const parsed = Number.parseInt(String(first).trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;

  const cacheKey = String(parsed);
  const now = Date.now();
  const cached = existenceCache.get(cacheKey);

  if (cached && cached.expires > now) {
    return cached.pending.then((value) => value);
  }

  const pending = db
    .get('SELECT 1 AS hit FROM players WHERE id = ?', [parsed])
    .then((row) => (row ? parsed : null))
    .catch(() => null)
    .then((value) => {
      existenceCache.set(cacheKey, { pending: Promise.resolve(value), expires: now + CACHE_TTL_MS });
      return value;
    });

  existenceCache.set(cacheKey, { pending, expires: now + CACHE_TTL_MS });
  return pending;
}

module.exports = { playerIdFromHeader, clearCache };