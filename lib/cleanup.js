// Periodic janitor: expired game sessions, stale images, expired sessions.
//
// The dangerous part of the previous version was the "orphaned image file"
// sweep, which deleted every .png in public/images that had no matching row in
// the `images` table. That table has never recorded Sharecam uploads (the
// uploadtransient route writes no row), so a sharecam snapshot was deleted on
// the very next sweep, and any hand-placed asset in the directory - the seeded
// posters, for example - was destroyed too. public/images is also served
// publicly, so real content was being silently lost.
//
// The sweep is now restricted to files matching this server's own upload
// naming conventions, and only when the file is also older than the retention
// window. Anything unrecognised is left alone.

const path = require('path');
const fs = require('fs');
const { db, run, get, all, transaction } = require('../database');
const { config } = require('./config');

const IMAGE_RETENTION_DAYS = 24 * 30;

/**
 * Filenames this server generates on upload.
 *
 *   <uuid>.png            multer sharecam / profile uploads
 *   <playerId>.png        profile image
 *   <epochMs>_<playerId>.png   cloud gallery upload
 *
 * Anything not matching one of these is treated as operator-provided content
 * and is never deleted.
 */
const GENERATED_NAME_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i,
  /^\d+\.png$/,
  /^\d+_\d+\.png$/
];

/**
 * @param {string} filename
 * @returns {boolean} true when this server could have produced the file
 */
function isServerGeneratedImage(filename) {
  return GENERATED_NAME_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * Delete game sessions past the retention window.
 * @returns {Promise<number>} rows removed
 */
async function cleanupOldGameSessions() {
  const cutoff = new Date(Date.now() - config.cleanup.gameSessionRetentionHours * 3600e3).toISOString();
  const result = await run('DELETE FROM game_sessions WHERE created_at < ?', [cutoff]);
  if (result.changes > 0) {
    console.log(`[Cleanup] Removed ${result.changes} expired game sessions`);
  }
  return result.changes;
}

/**
 * Delete expired and revoked auth sessions.
 *
 * The `sessions` table holds one row per login, so without this it grows
 * without bound and keeps the token digest of every session ever issued.
 *
 * @returns {Promise<number>} rows removed
 */
async function cleanupExpiredSessions() {
  const now = Date.now();
  const result = await run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [
    now,
    now - 24 * 3600e3
  ]);
  if (result.changes > 0) {
    console.log(`[Cleanup] Removed ${result.changes} expired/revoked sessions`);
  }
  return result.changes;
}

/**
 * Trim the account-creation audit log.
 * @returns {Promise<void>}
 */
async function cleanupAccountCreationLog() {
  const cutoff = Date.now() - 7 * 24 * 3600e3;
  await run('DELETE FROM account_creation_log WHERE created_at < ?', [cutoff]);
}

/**
 * Remove stale image rows and their files.
 *
 * @returns {Promise<number>} files removed
 */
async function cleanupOldImages() {
  const imagesDir = config.paths.images;
  const cutoffIso = new Date(Date.now() - IMAGE_RETENTION_DAYS * 24 * 3600e3).toISOString();
  const cutoffMs = Date.now() - IMAGE_RETENTION_DAYS * 24 * 3600e3;

  // Rows whose retention has lapsed. Single-quoted literals: SQLite accepts
  // double-quoted strings by falling back to treating them as identifiers,
  // which silently breaks if a column of that name is ever introduced.
  const stale = await all(
    "SELECT id, image_name, file_path FROM images WHERE uploaded_at < ? AND image_type IN ('transient', 'saved', 'cloud')",
    [cutoffIso]
  );

  let removed = 0;

  for (const image of stale) {
    // basename() so a stored path can never escape the images directory.
    const filePath = path.join(imagesDir, path.basename(image.image_path || image.file_path || ''));
    try {
      if (filePath.startsWith(path.resolve(imagesDir)) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed += 1;
      }
    } catch (err) {
      console.warn(`[Cleanup] Could not remove ${image.image_name}: ${err.message}`);
    }
    await run('DELETE FROM images WHERE id = ?', [image.id]);
  }

  // Rowless files: only ones this server could have generated, and only once
  // they are past the retention window. Transient sharecam images legitimately
  // have no row, so age - not row presence - is the correct test.
  let files = [];
  try {
    files = fs.readdirSync(imagesDir);
  } catch (err) {
    console.warn(`[Cleanup] Cannot read images directory: ${err.message}`);
    return removed;
  }

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.png')) continue;
    if (!isServerGeneratedImage(file)) continue; // operator-provided content

    const filePath = path.join(imagesDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs > cutoffMs) continue; // still within retention
      fs.unlinkSync(filePath);
      removed += 1;
    } catch (err) {
      console.warn(`[Cleanup] Could not remove ${file}: ${err.message}`);
    }
  }

  if (removed > 0) {
    console.log(`[Cleanup] Removed ${removed} stale image files`);
  }
  return removed;
}

/**
 * Reclaim database space.
 *
 * VACUUM takes an exclusive lock, so it is skipped when the process has only
 * just started (workers are still warming up) and when the database is busy.
 *
 * @returns {Promise<void>}
 */
async function maybeVacuum() {
  const state = cleanupDatabase;
  const now = Date.now();

  if (state.lastVacuum && now - state.lastVacuum < 24 * 3600e3) return;
  if (now - state.startTime < 5 * 60e3) return; // startup window

  try {
    await run('VACUUM');
    state.lastVacuum = now;
    console.log('[Cleanup] Database VACUUM completed');
  } catch (err) {
    // SQLITE_BUSY while workers hold the write lock is expected and harmless.
    console.warn(`[Cleanup] Skipping VACUUM: ${err.message}`);
  }
}

/**
 * Run every cleanup task.
 * @returns {Promise<void>}
 */
async function cleanupDatabase() {
  console.log('[Cleanup] Running maintenance...');
  const tasks = [cleanupOldGameSessions, cleanupOldImages, cleanupExpiredSessions, cleanupAccountCreationLog];

  for (const task of tasks) {
    try {
      await task();
    } catch (err) {
      // One failing task must not stop the others.
      console.error(`[Cleanup] ${task.name} failed:`, err.message);
    }
  }

  await maybeVacuum();
}

cleanupDatabase.startTime = Date.now();
cleanupDatabase.lastVacuum = 0;

/**
 * Start the cleanup scheduler. Invoked once, from the cluster master only, so
 * the jobs do not run four times in parallel.
 * @returns {NodeJS.Timeout}
 */
function startCleanupScheduler() {
  console.log(`[Cleanup] Scheduler started (every ${config.cleanup.intervalMs}ms)`);
  cleanupDatabase().catch((err) => console.error('[Cleanup] Initial run failed:', err.message));
  return setInterval(() => {
    cleanupDatabase().catch((err) => console.error('[Cleanup] Run failed:', err.message));
  }, config.cleanup.intervalMs);
}

module.exports = {
  startCleanupScheduler,
  cleanupDatabase,
  cleanupOldGameSessions,
  cleanupOldImages,
  cleanupExpiredSessions,
  isServerGeneratedImage
};