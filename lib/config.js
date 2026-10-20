// Central configuration.
//
// Every tunable and every secret is resolved here, once, at import time. Two
// reasons this is centralised rather than scattered as process.env reads:
//
//   1. Secrets must never have an insecure fallback. Previously JWT_SECRET was
//      read three separate times, each with a || 'change-this-secret-key'
//      default, so an unset variable silently downgraded signing to a
//      publicly-known key. Here a missing secret throws at startup instead.
//   2. Numeric knobs needed parsing and bounds. They were previously raw
//      strings compared against each other, which is how the memory GC
//      threshold ended up below the warning threshold and became unreachable.

const path = require('path');

// --- .env loading ---------------------------------------------------------
// A minimal reader so the project keeps its zero-config-restore behaviour.
// Real environment variables always win, so a service manager or container can
// override anything without editing the file.
//
// Deliberately stricter than the previous parser: it does not strip '#'
// comments from the middle of a value (a UUID or key containing '#' was being
// truncated), it validates key names, and it refuses to override an existing
// environment variable.

function loadDotEnv(file) {
  let contents;
  try {
    contents = require('fs').readFileSync(file, 'utf8');
  } catch {
    return; // No .env is a valid setup - rely on the real environment.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    // Only strip a trailing comment when the value is unquoted, so that
    // quoted values containing '#' survive intact.
    if (!/^["'].*["']$/s.test(value)) {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    // Strip matching surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

// --- parsing helpers ------------------------------------------------------

/**
 * Read a required secret. Throws rather than defaulting.
 * @param {string} name
 * @returns {string}
 */
function requiredSecret(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `[Config] ${name} is not set. Copy .env.example to .env and generate a value with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return value.trim();
}

/**
 * Read an optional secret. Returns '' when unset or blank.
 * @param {string} name
 * @returns {string}
 */
function optionalSecret(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read an integer with a fallback and inclusive bounds.
 * @param {string} name
 * @param {number} fallback
 * @param {{min?:number,max?:number}} [bounds]
 * @returns {number}
 */
function intWithDefault(name, fallback, bounds = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[Config] ${name}="${raw}" is not an integer; using ${fallback}`);
    return fallback;
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    console.warn(`[Config] ${name}=${parsed} below minimum ${bounds.min}; clamping`);
    return bounds.min;
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    console.warn(`[Config] ${name}=${parsed} above maximum ${bounds.max}; clamping`);
    return bounds.max;
  }
  return parsed;
}

/**
 * Read a boolean. Accepts true/1/yes/on.
 * @param {string} name
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolWithDefault(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Read a comma-separated list.
 * @param {string} name
 * @returns {string[]}
 */
function list(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// --- security-critical values -------------------------------------------

// Required. There is deliberately no default: an unset JWT_SECRET must stop
// the process, not downgrade it to a guessable key.
const jwtSecret = requiredSecret('JWT_SECRET');

// Required in production. Guards /dashboard, /api/dashboard/* and
// /api/moderation/*, and is the only way to grant the moderator role.
const adminKey = requiredSecret('ADMIN_KEY');

// Refuse known-bad values outright so a copy-pasted placeholder cannot ship.
for (const [name, value] of [
  ['JWT_SECRET', jwtSecret],
  ['ADMIN_KEY', adminKey]
]) {
  if (/^(change|replace|your|secret|test|password|admin)/i.test(value)) {
    throw new Error(
      `[Config] ${name} still looks like a placeholder. Generate a real one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  if (value.length < 32) {
    throw new Error(`[Config] ${name} is only ${value.length} characters; use at least 32.`);
  }
}

// --- composed config ------------------------------------------------------

const memoryWarning = intWithDefault('MEMORY_WARNING_THRESHOLD_MB', 1024, { min: 64, max: 65536 });
const memoryGc = intWithDefault('MEMORY_GC_THRESHOLD_MB', 1400, { min: 64, max: 65536 });
const memoryCritical = intWithDefault('MEMORY_CRITICAL_THRESHOLD_MB', 1536, {
  min: 64,
  max: 65536
});

if (!(memoryWarning < memoryGc && memoryGc < memoryCritical)) {
  throw new Error(
    `[Config] Memory thresholds must satisfy warning (${memoryWarning}) < ` +
      `gc (${memoryGc}) < critical (${memoryCritical}), otherwise some branches ` +
      `can never be reached.`
  );
}

const rootDir = path.join(__dirname, '..');

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',

  jwtSecret,
  adminKey,

  // Number of trusted reverse proxies. 0 means the server is directly exposed,
  // in which case Express must not trust X-Forwarded-For at all - otherwise a
  // client can spoof its own IP and defeat every rate limiter.
  trustProxy: intWithDefault('TRUST_PROXY', 0, { min: 0, max: 10 }),

  bindAddress: process.env.BIND_ADDRESS || '0.0.0.0',
  port: intWithDefault('PORT', 2056, { min: 1, max: 65535 }),
  wsPort: intWithDefault('WS_PORT', 2059, { min: 1, max: 65535 }),
  cdnPort: intWithDefault('CDN_PORT', 2058, { min: 1, max: 65535 }),
  // 0 means "one worker per logical CPU".
  clusterWorkers: intWithDefault('CLUSTER_WORKERS', 0, { min: 0, max: 64 }),

  // Empty means "any platform_id may create an account".
  allowedPlatformIds: list('ALLOWED_PLATFORM_IDS'),
  accountCreationMaxPerHour: intWithDefault('ACCOUNT_CREATION_MAX_PER_HOUR', 5, {
    min: 0,
    max: 10000
  }),

  corsOrigins: list('CORS_ORIGINS'),
  corsAllowAll: (process.env.CORS_ORIGINS || '').trim() === '*',

  rateLimit: {
    windowMs: intWithDefault('RATE_LIMIT_WINDOW_MS', 900000, { min: 1000 }),
    max: intWithDefault('RATE_LIMIT_MAX_REQUESTS', 3000, { min: 1 })
  },
  loginRateLimit: {
    windowMs: intWithDefault('LOGIN_RATE_LIMIT_WINDOW_MS', 900000, { min: 1000 }),
    max: intWithDefault('LOGIN_RATE_LIMIT_MAX_REQUESTS', 20, { min: 1 })
  },

  sessionLifetimeMs: intWithDefault('SESSION_LIFETIME_HOURS', 168, { min: 1, max: 8760 }) * 3600e3,
  // How often a live session's last_seen_at is written. Avoids a DB write on
  // every single request.
  sessionTouchIntervalMs: intWithDefault('SESSION_TOUCH_INTERVAL_MS', 60000, { min: 5000 }),

  photon: {
    realtimeAppId: optionalSecret('PHOTON_REALTIME_APP_ID'),
    voiceAppId: optionalSecret('PHOTON_VOICE_APP_ID'),
    chatAppId: optionalSecret('PHOTON_CHAT_APP_ID'),
    region: optionalSecret('PHOTON_REGION') || 'us'
  },

  ignoreVersionCheck: boolWithDefault('IGNORE_VERSION_CHECK', true),

  cleanup: {
    intervalMs: intWithDefault('CLEANUP_INTERVAL_MS', 3600000, { min: 60000 }),
    gameSessionRetentionHours: intWithDefault('GAME_SESSION_RETENTION_HOURS', 24, { min: 1 })
  },

  memory: {
    intervalMs: intWithDefault('MEMORY_CHECK_INTERVAL_MS', 60000, { min: 5000 }),
    warningMb: memoryWarning,
    gcMb: memoryGc,
    criticalMb: memoryCritical
  },

  paths: {
    root: rootDir,
    public: path.join(rootDir, 'public'),
    images: path.join(rootDir, 'public', 'images'),
    data: path.join(rootDir, 'data'),
    databasePath: process.env.DATABASE_PATH || path.join(rootDir, 'database.sqlite')
  },

  // Limits applied to uploads and request bodies.
  limits: {
    jsonBody: '1mb',
    uploadBytes: 5 * 1024 * 1024,
    maxUsernameLength: 32,
    maxDisplayNameLength: 32,
    maxRoomNameLength: 64,
    maxRoomDescriptionLength: 256,
    maxPlayersPerRoom: 500,
    maxSettingsKeyLength: 64,
    maxSettingsValueLength: 4096,
    maxIdListLength: 200
  }
};

module.exports = { config, loadDotEnv };