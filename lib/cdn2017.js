// CDN server for the 2017 protocol.
//
// The 2017 client fetches the player's profile picture (and Sharecam images)
// through a CDN base URI advertised in /api/config/v2. Rec.js runs this as its
// own process on a separate port; here it is exposed both as a standalone
// listener and as a router mounted on the API port, so a client reaching the
// server through a single-port tunnel still works.
//
// Changes from the previous version:
//   - the three handlers were duplicated verbatim between `router` and `start`.
//     They now exist once.
//   - the wildcard handler built a path with path.join(req.path) and passed it
//     straight to res.sendFile with no containment check. Every lookup is now
//     resolved and verified to sit inside the images directory.
//   - a request that resolves to a directory used to reach sendFile and 500.
//   - per-request logging on every asset fetch is gone; it was unbounded.

const express = require('express');
const path = require('path');
const fs = require('fs');
const { config } = require('./config');

const IMAGES_DIR = config.paths.images;
const DEFAULT_IMAGE = path.join(IMAGES_DIR, '__default.png');

// Real path of the images directory, resolved once. Every candidate path is
// compared against this, so a symlinked images dir is handled correctly.
const REAL_IMAGES_DIR = (() => {
  try {
    return fs.realpathSync(IMAGES_DIR);
  } catch {
    return path.resolve(IMAGES_DIR);
  }
})();

/** Extensions the CDN will serve. Anything else is refused outright. */
const SERVABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Resolve a requested filename to an absolute path inside the images directory,
 * or null if it would escape.
 *
 * Containment is checked on the *resolved* path with a trailing separator, so
 * `..` segments, absolute paths, and Windows drive-relative paths are all
 * rejected. Comparing against `REAL_IMAGES_DIR + sep` rather than
 * `startsWith(REAL_IMAGES_DIR)` also prevents the classic sibling-directory
 * bypass where `/images-evil` passes a prefix test against `/images`.
 *
 * @param {string} requested raw name from the URL
 * @returns {string|null} absolute path, or null when outside the images dir
 */
function resolveInsideImages(requested) {
  if (typeof requested !== 'string' || requested.length === 0) return null;
  // Reject NUL and other control characters outright; they have no legitimate
  // use in an asset name and truncate paths in some native layers.
  if (/[\0-\x1f\x7f]/.test(requested)) return null;

  // Strip any leading separators so the join cannot be re-rooted.
  const cleaned = requested.replace(/^[/\\]+/, '');

  const candidate = path.resolve(IMAGES_DIR, cleaned);
  const prefix = REAL_IMAGES_DIR.endsWith(path.sep) ? REAL_IMAGES_DIR : REAL_IMAGES_DIR + path.sep;

  if (candidate !== REAL_IMAGES_DIR && !candidate.startsWith(prefix)) return null;

  const ext = path.extname(candidate).toLowerCase();
  if (!SERVABLE_EXTENSIONS.has(ext)) return null;

  return candidate;
}

/**
 * True when the path exists and is a regular file (not a directory, not a
 * device).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isReadableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Send an asset, falling back to the default profile image.
 *
 * @param {import('express').Response} res
 * @param {string|null} filePath resolved candidate, or null if rejected
 */
function sendImage(res, filePath) {
  if (filePath && isReadableFile(filePath)) {
    res.sendFile(filePath, (err) => {
      // sendFile calls back with an error if the response already ended or the
      // client aborted. Nothing useful to do, but it must be handled or the
      // process emits an unhandled error.
      if (err && !res.headersSent) res.status(404).end();
    });
    return;
  }

  if (isReadableFile(DEFAULT_IMAGE)) {
    res.sendFile(DEFAULT_IMAGE, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
    return;
  }

  res.status(404).send('No CDN image available');
}

/**
 * Register the CDN routes on an Express app or router.
 *
 * @param {import('express').Application|import('express').Router} target
 */
function register(target) {
  // Sharecam images, named by uuid.
  target.get('/image/:imagename', (req, res) => {
    const name = String(req.params.imagename).replace(/[^a-zA-Z0-9._-]/g, '');
    sendImage(res, resolveInsideImages(`${name}.png`));
  });

  // Profile images, named by numeric player id.
  target.get('/profile/:id', (req, res) => {
    const id = String(req.params.id).replace(/[^0-9]/g, '');
    if (!id) return sendImage(res, null);
    return sendImage(res, resolveInsideImages(`${id}.png`));
  });

  // Catch-all for bare asset names. Registered last so the specific routes
  // above take precedence.
  target.get('/*', (req, res) => {
    sendImage(res, resolveInsideImages(req.path));
  });
}

// Mountable version, for the /cdn mount on the API port.
const router = express.Router();
register(router);

/**
 * Start the standalone CDN listener.
 *
 * @param {number} [port]
 * @returns {import('http').Server}
 */
function start(port = config.cdnPort) {
  const app = express();
  register(app);

  const server = app.listen(Number(port), config.bindAddress, () => {
    console.log(`[CDN] Listening on ${config.bindAddress}:${port}`);
  });

  server.on('error', (err) => {
    console.error(`[CDN] Failed to start on port ${port}: ${err.message}`);
  });

  return server;
}

module.exports = { start, router, resolveInsideImages, REAL_IMAGES_DIR };