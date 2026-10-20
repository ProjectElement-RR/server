// SQLite access layer and schema management.
//
// One connection handle is exported and shared by the whole process. With
// cluster.fork() the master and each worker open their own handle to the same
// file, so the pragmas below matter: WAL lets readers and one writer work
// concurrently, and busy_timeout makes contending writers wait instead of
// throwing SQLITE_BUSY immediately.
//
// Migrations are tracked in a `schema_migrations` table and are additive only.
// Column additions are driven by PRAGMA table_info rather than by catching
// "duplicate column" in an error message, which is locale-dependent and
// silently misreports what actually happened.

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { config } = require('./lib/config');

const dbPath = config.databasePath;

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[Database] Failed to open', dbPath, err);
    process.exitCode = 1;
    return;
  }
  db.serialize(() => {
    // WAL: concurrent readers alongside a single writer. Required because the
    // cluster runs several processes against one file.
    db.run('PRAGMA journal_mode = WAL');
    // Wait up to 10s for a lock instead of failing instantly. The master runs
    // VACUUM while four workers write, so contention is expected.
    db.run('PRAGMA busy_timeout = 10000');
    // Off by default in SQLite; without this every FOREIGN KEY clause in the
    // schema is decorative.
    db.run('PRAGMA foreign_keys = ON');
    // Bound WAL growth so it gets checkpointed into the main db file.
    db.run('PRAGMA wal_autocheckpoint = 1000');
    // NORMAL is the recommended durability level under WAL: safe against
    // application crashes, may lose the last transactions on OS crash only.
    db.run('PRAGMA synchronous = NORMAL');
  });

  migrate()
    .then(() => {
      console.log('[Database] Ready at', dbPath);
      db.emit('ready');
    })
    .catch((migrationError) => {
      console.error('[Database] Migration failed:', migrationError);
      process.exitCode = 1;
      db.emit('error', migrationError);
    });
});

// --- tiny promise helpers -------------------------------------------------
// The sqlite3 callback API is the only interface available; these keep the
// route handlers readable.

/**
 * Run a statement and invoke cb with the changes/lastID info.
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {Promise<{changes:number,lastID:number}>}
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onDone(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

/**
 * Fetch a single row.
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {Promise<object|undefined>}
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

/**
 * Fetch all rows.
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {Promise<object[]>}
 */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

/**
 * Wrap fn in an IMMEDIATE transaction so concurrent writers serialise instead
 * of interleaving a read-modify-write. IMMEDIATE takes the write lock up front,
 * which avoids the SQLITE_BUSY upgrade deadlock that DEFERRED transactions can
 * hit.
 *
 * @template T
 * @param {(tx:{run:typeof run,get:typeof get,all:typeof all}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function transaction(fn) {
  await run('BEGIN IMMEDIATE');
  try {
    const result = await fn({ run, get, all });
    await run('COMMIT');
    return result;
  } catch (err) {
    try {
      await run('ROLLBACK');
    } catch {
      // Rollback can fail if the transaction was already aborted by SQLite.
      // The original error is the one worth surfacing.
    }
    throw err;
  }
}

// --- migrations -----------------------------------------------------------

/** Columns added to pre-existing tables. Checked via PRAGMA table_info. */
const ADDED_COLUMNS = [
  { table: 'players', column: 'display_name', ddl: 'display_name TEXT' },
  { table: 'players', column: 'avatar', ddl: "avatar TEXT DEFAULT '{}'" },
  {
    table: 'players',
    column: 'moderation_data',
    ddl: `moderation_data TEXT DEFAULT '{"banned":false,"reason":"","expires":0}'`
  },
  { table: 'players', column: 'profile_image', ddl: 'profile_image TEXT' },
  // New in this revision: privilege and global token invalidation.
  { table: 'players', column: 'is_moderator', ddl: 'is_moderator INTEGER NOT NULL DEFAULT 0' },
  { table: 'players', column: 'token_version', ddl: 'token_version INTEGER NOT NULL DEFAULT 0' }
];

/** Tables created fresh. IF NOT EXISTS makes this safe on every boot. */
const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS players (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT UNIQUE NOT NULL,
     display_name TEXT,
     steam_id TEXT,
     created_at TEXT DEFAULT CURRENT_TIMESTAMP,
     xp INTEGER DEFAULT 0,
     level INTEGER DEFAULT 1,
     session_token TEXT,
     is_banned INTEGER NOT NULL DEFAULT 0,
     avatar TEXT DEFAULT '{}'
   )`,
  `CREATE TABLE IF NOT EXISTS avatars (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id INTEGER NOT NULL,
     avatar_data TEXT NOT NULL,
     updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (player_id) REFERENCES players(id)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id INTEGER NOT NULL,
     settings_data TEXT NOT NULL,
     updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (player_id) REFERENCES players(id)
   )`,
  `CREATE TABLE IF NOT EXISTS game_sessions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     room_id TEXT NOT NULL,
     room_name TEXT NOT NULL,
     host_id INTEGER NOT NULL,
     players TEXT NOT NULL,
     is_private INTEGER DEFAULT 0,
     max_players INTEGER DEFAULT 4,
     created_at TEXT DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (host_id) REFERENCES players(id)
   )`,
  `CREATE TABLE IF NOT EXISTS friends (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id INTEGER NOT NULL,
     friend_id INTEGER NOT NULL,
     status TEXT DEFAULT 'pending',
     created_at TEXT DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (player_id) REFERENCES players(id),
     FOREIGN KEY (friend_id) REFERENCES players(id)
   )`,
  `CREATE TABLE IF NOT EXISTS images (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id INTEGER NOT NULL,
     image_name TEXT NOT NULL,
     image_type TEXT DEFAULT 'profile',
     file_path TEXT NOT NULL,
     uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY (player_id) REFERENCES players(id)
   )`,
  // Server-side session store. Makes revocation, expiry enforcement and ban
  // enforcement possible - a self-contained JWT alone cannot do any of those.
  `CREATE TABLE IF NOT EXISTS sessions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     jti TEXT NOT NULL UNIQUE,
     player_id INTEGER NOT NULL,
     token_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     revoked_at INTEGER,
     revoked_reason TEXT,
     ip TEXT,
     user_agent TEXT,
     FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     name TEXT PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`,
  // Records when a platform_id first created an account, so the
  // account-creation throttle can be enforced across workers.
  `CREATE TABLE IF NOT EXISTS account_creation_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     platform_id TEXT,
     player_id INTEGER,
     ip TEXT,
     created_at INTEGER NOT NULL
   )`
];

/**
 * Indices. Added after the tables exist so they can be created against
 * pre-existing data without error.
 */
const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_players_steam_id ON players(steam_id)',
  'CREATE INDEX IF NOT EXISTS idx_players_banned ON players(is_banned)',
  'CREATE INDEX IF NOT EXISTS idx_players_xp ON players(xp DESC)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(player_id, revoked_at, expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_game_sessions_created ON game_sessions(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_images_player ON images(player_id)',
  'CREATE INDEX IF NOT EXISTS idx_images_type ON images(image_type)',
  'CREATE INDEX IF NOT EXISTS idx_account_creation_time ON account_creation_log(created_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_pair ON friends(player_id, friend_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_player_objectives_unique ON player_objectives(player_id, objective_type)'
];

/**
 * One-off data repairs for databases created by older builds. These run once
 * each and are recorded in schema_migrations.
 *
 * weekly_progress and player_objectives were originally created by
 * routes/challenge.js at require time with a schema that later diverged from
 * what that file went on to query, which made /api/challenge/v*weekly and
 * /v*updateProgress fail with "no such column" against an existing database.
 */
const DATA_REPAIRS = [
  {
    name: 'weekly_progress_add_challenge_map_id',
    async apply() {
      const columns = await tableColumns('weekly_progress');
      if (columns.size === 0) return; // table not created yet; challenge.js owns it
      if (!columns.has('challenge_map_id')) {
        await run('ALTER TABLE weekly_progress ADD COLUMN challenge_map_id TEXT');
      }
      if (!columns.has('week_number')) {
        await run('ALTER TABLE weekly_progress ADD COLUMN week_number INTEGER');
      }
    }
  },
  {
    // Several tables used double-quoted string literals in WHERE clauses. SQLite
    // tolerates this by falling back to treating them as identifiers, which
    // breaks if a column of that name is ever added. Rewrite the taxonomy to
    // the values the routes actually write.
    name: 'normalize_image_type_values',
    async apply() {
      const columns = await tableColumns('images');
      if (columns.size === 0) return;
      await run("UPDATE images SET image_type = 'profile' WHERE image_type = 'shared.profile_image'");
      await run("UPDATE images SET image_type = 'saved' WHERE image_type = 'sharecam'");
      await run("DELETE FROM images WHERE image_type IS NULL OR image_type = ''");
    }
  },
  {
    // A single session_token column cannot represent multiple concurrent
    // logins - every login overwrote the previous one. Nothing reads it now;
    // clear it so no stale secret lingers in the database.
    name: 'clear_legacy_session_tokens',
    async apply() {
      await run('UPDATE players SET session_token = NULL WHERE session_token IS NOT NULL');
    }
  }
];

/**
 * Names of columns on a table.
 * @param {string} table
 * @returns {Promise<Set<string>>}
 */
async function tableColumns(table) {
  // table_info cannot take a bound parameter; the name is a literal from the
  // migration tables above, never user input.
  const rows = await all(`PRAGMA table_info(${JSON.stringify(table)})`);
  return new Set(rows.map((r) => r.name));
}

/**
 * Names of tables in the database.
 * @returns {Promise<Set<string>>}
 */
async function tableNames() {
  const rows = await all("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(rows.map((r) => r.name));
}

/**
 * Apply every pending schema change. Safe to call on every boot.
 * @returns {Promise<void>}
 */
async function migrate() {
  const tables = await tableNames();

  // The migration ledger must exist before anything can be recorded.
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
     name TEXT PRIMARY KEY,
     applied_at INTEGER NOT NULL
   )`);

  const applied = new Set((await all('SELECT name FROM schema_migrations')).map((r) => r.name));

  // Tables first, so index creation has something to attach to.
  for (const ddl of CREATE_TABLES) {
    await run(ddl);
  }

  // Then any missing columns on tables that predate this revision.
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const columns = await tableColumns(table);
    if (columns.has(column)) continue;
    await run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[Database] Added column ${table}.${column}`);
  }

  // Data repairs, each at most once.
  for (const repair of DATA_REPAIRS) {
    if (applied.has(repair.name)) continue;
    await repair.apply();
    await run('INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)', [
      repair.name,
      Date.now()
    ]);
    console.log(`[Database] Applied repair ${repair.name}`);
  }

  // Indices last: player_objectives is created by challenge.js on first boot, so
  // its unique index may only become possible on a later pass. The migration
  // ledger prevents re-running repairs but not index creation, which is
  // inherently idempotent and cheap when already present.
  await ensureObjectiveTables();
  for (const ddl of CREATE_INDEXES) {
    try {
      await run(ddl);
    } catch (err) {
      // A unique index can legitimately fail if the table has existing
      // duplicates. Log it rather than aborting startup: everything else in
      // the schema is still valid, and failing here would take the server
      // down over a repairable inconsistency.
      console.warn(`[Database] Skipped index (${ddl.split(' ')[5] || ddl}): ${err.message}`);
    }
  }

  console.log('[Database] Schema up to date');
}

/**
 * Ensure the objective tables exist.
 *
 * These were historically created at require-time inside routes/challenge.js,
 * which meant a fresh database had them appear only once that route module was
 * loaded - and a write to player_objectives from routes/players.js could
 * therefore hit "no such table". Owning them here means they always exist and
 * always match the queries that run against them.
 *
 * @returns {Promise<void>}
 */
async function ensureObjectiveTables() {
  await run(`CREATE TABLE IF NOT EXISTS player_objectives (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id INTEGER NOT NULL,
     objective_type TEXT NOT NULL,
     progress INTEGER NOT NULL DEFAULT 0,
     target INTEGER NOT NULL DEFAULT 0,
     is_completed INTEGER NOT NULL DEFAULT 0,
     completed_at INTEGER,
     FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
   )`);

  await run(`CREATE TABLE IF NOT EXISTS weekly_progress (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id INTEGER NOT NULL,
     challenge_id TEXT,
     challenge_map_id TEXT,
     week_number INTEGER,
     progress INTEGER NOT NULL DEFAULT 0,
     completed INTEGER NOT NULL DEFAULT 0,
     completed_at INTEGER,
     FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
   )`);
}

module.exports = db;
module.exports.run = run;
module.exports.get = get;
module.exports.all = all;
module.exports.transaction = transaction;
module.exports.migrate = migrate;
module.exports.ensureObjectiveTables = ensureObjectiveTables;
module.exports.dbPath = dbPath;
