// Secret hashing and constant-time comparison.
//
// Uses scrypt from Node's built-in crypto module. scrypt is a memory-hard KDF,
// which is why this is preferable to a plain iterated hash (SHA-256/SHA-512) for
// anything derived from a human-chosen secret: it is expensive in both CPU and
// memory to attack, and the parameters are recorded per-hash so old hashes stay
// verifiable after the cost is raised.
//
// No third-party dependency. node:crypto is always present and always audited.
//
// Stored format (single self-describing string):
//
//   scrypt$N$r$p$<salt-hex>$<hash-hex>
//
// The parameters travel with the hash, so verifySecret() can tell whether a
// stored secret needs to be re-hashed at a higher cost.

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

// Current cost parameters. N=2^15 with r=8 costs roughly 32 MB per hash, which
// is a reasonable 2017-era-authenticator default: fast enough to run inline on
// a login request, slow enough to make offline cracking of a stolen table
// expensive. Raise N (and maxmem) as hardware improves - rehash on next login.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

// scrypt needs roughly 128 * N * r bytes; give it headroom over the default 32 MB
// so the N above does not silently fail.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const ALGORITHM = 'scrypt';

/**
 * Hash a secret with scrypt.
 *
 * @param {string} secret plaintext to protect
 * @param {string} [saltHex] reuse an existing salt (hex); a random one is made if omitted
 * @returns {Promise<string>} self-describing hash string
 */
async function hashSecret(secret, saltHex) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('hashSecret requires a non-empty string');
  }

  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  if (salt.length !== 16) {
    throw new TypeError('salt must be 16 bytes');
  }

  const derived = await scryptAsync(secret.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  });

  return [
    ALGORITHM,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    derived.toString('hex')
  ].join('$');
}

/**
 * Verify a secret against a stored hash in constant time.
 *
 * Returns false (never throws) for malformed or missing stored values, so a
 * corrupt row in the database cannot be used to bypass a check or to crash a
 * request handler.
 *
 * @param {string} secret plaintext to check
 * @param {string} stored value produced by hashSecret
 * @returns {Promise<boolean>}
 */
async function verifySecret(secret, stored) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof stored !== 'string' || stored.length === 0) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  const saltHex = parts[4];
  const hashHex = parts[5];

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!Number.isSafeInteger(N) || N < 2 || (N & (N - 1)) !== 0) return false; // N must be a power of two
  if (r < 1 || p < 1) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;

  let expected;
  let actual;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    expected = await scryptAsync(secret.normalize('NFKC'), salt, hashHex.length / 2, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM
    });
    actual = Buffer.from(hashHex, 'hex');
  } catch {
    // Cost parameters in the stored row exceed maxmem, or the hash is truncated.
    return false;
  }

  if (expected.length !== actual.length) return false;

  // Fixed-time compare. Length already checked, so this cannot leak length info.
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * True when a stored hash was produced with weaker parameters than the current
 * cost, meaning the secret should be re-hashed on next successful login.
 *
 * @param {string} stored
 * @returns {boolean}
 */
function needsRehash(stored) {
  if (typeof stored !== 'string') return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return true;
  return Number.parseInt(parts[1], 10) < SCRYPT_N;
}

/**
 * Constant-time string compare for values that are not stored hashed (for
 * example comparing a presented API key against a configured one).
 *
 * Hashes both sides to a fixed length first so timingSafeEqual always receives
 * equal-length buffers and the comparison itself cannot short-circuit.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;

  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Generate a URL-safe random token/secret.
 *
 * @param {number} [bytes=32] entropy in bytes
 * @returns {string}
 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = {
  ALGORITHM,
  SCRYPT_N,
  hashSecret,
  verifySecret,
  needsRehash,
  safeEqual,
  randomToken
};