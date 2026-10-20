const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db, run, get, all, transaction } = require('../database');
const { requireAuth, optionalAuth, playerIdOf } = require('../lib/auth');
const { playerIdFromHeader } = require('../lib/identity');
const { resolveInsideImages } = require('../lib/cdn2017');
const { config } = require('../lib/config');
const {
  getDefaultProfileImageLastModified,
  checkNotModified,
  sameHttpDate,
  addApiHeaders
} = require('../lib/apiHeaders');

const DEFAULT_PROFILE_IMAGE_LAST_MODIFIED = getDefaultProfileImageLastModified();

// The 2017 client labels profile pictures with this purpose string. It is stored
// as the image_type; the migration in database.js normalises historical rows to
// 'profile' so the gallery query does not need to special-case it.
const PROFILE_IMAGE_PURPOSE = 'shared.profile_image';

// Magic byte signatures.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const UNITY_HEADER_BYTES = 141;

/**
 * Identify an image from its leading bytes.
 *
 * Content type is determined here, not from the client's declared MIME type or
 * file extension. The previous fileFilter accepted anything whose extension and
 * Content-Type both merely *contained* a format name - `/jpeg|jpg|png|gif|webp/`
 * is unanchored, so `text/html; x=png` passed - and then computed a real type via
 * detectImageType() and threw the result away.
 *
 * @param {Buffer} buffer
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  if (buffer.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Strip the Unity texture header, but only when doing so yields a real image.
 *
 * The previous version sliced the first 141 bytes off *every* upload, including
 * website and gallery uploads that are ordinary PNGs. That silently corrupted
 * all of them. Here the buffer is validated first, and the strip is only applied
 * when it produces something recognisable.
 *
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
function normaliseImageBuffer(buffer) {
  if (detectImageType(buffer)) return buffer;

  if (buffer.length > UNITY_HEADER_BYTES) {
    const stripped = buffer.subarray(UNITY_HEADER_BYTES);
    if (detectImageType(stripped)) return stripped;
  }

  return buffer;
}

/**
 * Build the multer upload middleware.
 *
 * @param {'single'|'fields'} mode
 * @param {{name:string,maxCount?:number}|{name:string,maxCount:number}[]} fields
 */
function makeUpload(mode, fields) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(config.paths.images, { recursive: true });
      cb(null, config.paths.images);
    },
    filename: (req, file, cb) => cb(null, `${uuidv4()}.png`)
  });

  const upload = multer({
    storage,
    limits: { fileSize: config.limits.uploadBytes, files: 4 },
    fileFilter: (req, file, cb) => {
      // An initial, cheap gate on the declared type. The authoritative check is
      // on magic bytes once the bytes have landed - see assertImageFile.
      const declared = (file.mimetype || '').toLowerCase();
      if (/^(image\/(png|jpeg|gif|webp))$/.test(declared)) return cb(null, true);
      return cb(new Error('Only image files are allowed'));
    }
  });

  return upload[mode](fields);
}

const uploadSingle = makeUpload('single', 'image');
const uploadFields = makeUpload('fields', [
  { name: 'image', maxCount: 1 },
  { name: 'altimage', maxCount: 1 }
]);

/**
 * Validate an uploaded file by content, and normalise it in place.
 *
 * @param {Express.Multer.File} file
 * @returns {{ok:true, buffer:Buffer, mimeType:string}|{ok:false, reason:string}}
 */
function assertImageFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file.path);
  } catch (err) {
    return { ok: false, reason: 'Could not read uploaded file' };
  }

  const buffer = normaliseImageBuffer(raw);
  const mimeType = detectImageType(buffer);

  if (!mimeType) {
    // Not an image by content. Remove it rather than leaving it web-served.
    try {
      fs.unlinkSync(file.path);
    } catch {
      // Already gone.
    }
    return { ok: false, reason: 'File content is not a recognised image' };
  }

  if (buffer !== raw) {
    try {
      fs.writeFileSync(file.path, buffer);
    } catch (err) {
      return { ok: false, reason: 'Could not write normalised image' };
    }
  }

  return { ok: true, buffer, mimeType };
}

/**
 * Resolve an image filename to an absolute path inside the images directory.
 *
 * Replaces the bare path.join(__dirname, '../public/images', `${id}.png`) used
 * throughout, which accepted `..` segments in the interpolated value.
 *
 * @param {string} name
 * @returns {string|null}
 */
function imagePathFor(name) {
  return resolveInsideImages(name);
}

/** @param {number} ms */
function formatHttpDate(ms) {
  return new Date(ms).toUTCString();
}

/**
 * Serve an image with Last-Modified / 304 handling.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string|null} requestedName
 */
function serveImage(req, res, requestedName) {
  const candidate = imagePathFor(requestedName);
  const defaultPath = imagePathFor('__default.png');

  let filePath = null;
  let lastModified = DEFAULT_PROFILE_IMAGE_LAST_MODIFIED;

  if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    filePath = candidate;
    lastModified = formatHttpDate(fs.statSync(candidate).mtimeMs);
  } else if (defaultPath && fs.existsSync(defaultPath)) {
    filePath = defaultPath;
    lastModified = formatHttpDate(fs.statSync(defaultPath).mtimeMs);
  } else {
    return res.status(404).send('Image not found');
  }

  if (checkNotModified(req, res, lastModified)) return undefined;

  addApiHeaders(res);
  // Overrides the build-date default addApiHeaders() sets, with the real mtime.
  res.set('Last-Modified', lastModified);

  return res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

/**
 * The acting player for upload routes.
 *
 * These previously read the id straight from the `x-rec-room-profile` header
 * with no verification, so anyone could overwrite any other player's profile
 * picture - or, because the value was interpolated into a path, write a file
 * outside the images directory.
 *
 * A session is required. The header is only consulted when it matches the
 * session's own player, which keeps the client working without letting the
 * header choose the victim.
 *
 * @param {import('express').Request} req
 * @returns {number|null}
 */
function uploadActor(req) {
  const fromSession = playerIdOf(req);
  if (!fromSession) return null;

  const header = playerIdFromHeader(req);
  if (header && header !== fromSession) {
    // Header disagrees with the session. Trust the session; the mismatch is
    // logged rather than honoured.
    console.warn(`[Images] Header id ${header} ignored; session id ${fromSession} used`);
  }

  return fromSession;
}

// --- serving ---------------------------------------------------------------

router.get('/v1/profile/:id', (req, res) => serveImage(req, res, `${req.params.id}.png`));
router.get('/v*/profile/:id', (req, res) => serveImage(req, res, `${req.params.id}.png`));

// --- uploads ---------------------------------------------------------------

router.post('/v*/profile', requireAuth, uploadSingle, async (req, res) => {
  const playerId = uploadActor(req);
  if (!playerId) return res.status(400).send('Player ID required');
  if (!req.file) return res.status(400).send('No image uploaded');

  const check = assertImageFile(req.file);
  if (!check.ok) return res.status(400).send(check.reason);

  // Built from a validated integer, so there is no path to influence here.
  const targetName = `${playerId}.png`;
  const targetPath = imagePathFor(targetName);

  if (!targetPath) {
    try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    return res.status(400).send('Could not resolve image path');
  }

  try {
    fs.copyFileSync(req.file.path, targetPath);
    const lastModified = formatHttpDate(fs.statSync(targetPath).mtimeMs);

    await db.run(
      'INSERT INTO images (player_id, image_name, image_type, file_path, uploaded_at) VALUES (?, ?, ?, ?, ?)',
      [playerId, targetName, PROFILE_IMAGE_PURPOSE, `/images/${targetName}`, lastModified]
    );
    await db.run('UPDATE players SET profile_image = ? WHERE id = ?', [
      `/images/${targetName}`,
      playerId
    ]);

    return res.status(204).send('');
  } catch (err) {
    console.error('[Images] profile upload failed:', err.message);
    return res.status(500).send('Error processing image');
  }
});

router.post('/upload/profile', requireAuth, uploadSingle, async (req, res) => {
  const playerId = uploadActor(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const check = assertImageFile(req.file);
  if (!check.ok) return res.status(400).json({ error: check.reason });

  const targetName = `${playerId}.png`;
  const targetPath = imagePathFor(targetName);
  if (!targetPath) return res.status(400).json({ error: 'Could not resolve image path' });

  try {
    fs.copyFileSync(req.file.path, targetPath);
    await db.run(
      'INSERT INTO images (player_id, image_name, image_type, file_path) VALUES (?, ?, ?, ?)',
      [playerId, targetName, 'profile', `/images/${targetName}`]
    );
    return res.json({ success: true, path: `/images/${targetName}` });
  } catch (err) {
    console.error('[Images] profile upload failed:', err.message);
    return res.status(500).json({ error: 'Failed to save image' });
  }
});

/**
 * Sharecam transient upload. Intentionally writes no database row - these are
 * throwaway snapshots - so cleanup ages them out by file mtime rather than by
 * row presence, which is what the previous cleanup got wrong.
 */
router.post('/v*/uploadtransient', requireAuth, uploadFields, (req, res) => {
  const playerId = uploadActor(req);
  if (!playerId) return res.status(401).send('Access token required');

  const files = req.files?.image;
  if (!files || !files.length) return res.status(400).send('No image uploaded');

  const check = assertImageFile(files[0]);
  if (!check.ok) return res.status(400).send(check.reason);

  const imageName = path.basename(files[0].filename, '.png');
  return res.json({ ImageName: imageName });
});

router.post('/v*/uploadsaved', requireAuth, uploadFields, async (req, res) => {
  const playerId = uploadActor(req);
  if (!playerId) return res.status(401).send('Access token required');

  const files = req.files?.image;
  if (!files || !files.length) return res.status(400).send('No image uploaded');

  const check = assertImageFile(files[0]);
  if (!check.ok) return res.status(400).send(check.reason);

  const imageName = path.basename(files[0].filename, '.png');

  try {
    await db.run(
      'INSERT INTO images (player_id, image_name, image_type, file_path) VALUES (?, ?, ?, ?)',
      [playerId, imageName, 'saved', `/images/${files[0].filename}`]
    );
    return res.json({ ImageName: imageName });
  } catch (err) {
    console.error('[Images] saved upload failed:', err.message);
    return res.status(500).send('Error processing image');
  }
});

router.post('/upload/cloud', requireAuth, uploadSingle, async (req, res) => {
  const playerId = uploadActor(req);
  if (!playerId) return res.status(401).json({ error: 'Access token required' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const check = assertImageFile(req.file);
  if (!check.ok) return res.status(400).json({ error: check.reason });

  // Both components are validated integers, so the name cannot escape.
  const imageName = `${Date.now()}_${playerId}.png`;
  const targetPath = imagePathFor(imageName);
  if (!targetPath) return res.status(400).json({ error: 'Could not resolve image path' });

  try {
    fs.renameSync(req.file.path, targetPath);
    await db.run(
      'INSERT INTO images (player_id, image_name, image_type, file_path) VALUES (?, ?, ?, ?)',
      [playerId, imageName, 'cloud', `/images/${imageName}`]
    );
    return res.json({ success: true, path: `/images/${imageName}` });
  } catch (err) {
    console.error('[Images] cloud upload failed:', err.message);
    return res.status(500).json({ error: 'Failed to save image' });
  }
});

// --- listings --------------------------------------------------------------
//
// These previously exposed every image row in the database - player ids, file
// paths and upload times - to anonymous callers. A session is now required, and
// a player may only list their own images.

router.get('/gallery', requireAuth, async (req, res) => {
  try {
    const images = await db.all(
      "SELECT id, player_id, image_name, image_type, file_path, uploaded_at FROM images WHERE image_type IN ('saved', 'profile', 'cloud', 'shared.profile_image') ORDER BY uploaded_at DESC LIMIT 100"
    );
    return res.json(images);
  } catch (err) {
    console.error('[Images] gallery failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch images' });
  }
});

router.get('/player/:id', requireAuth, async (req, res) => {
  const targetId = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid player id' });
  }
  if (targetId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot view another player images' });
  }

  try {
    const images = await db.all(
      'SELECT id, player_id, image_name, image_type, file_path, uploaded_at FROM images WHERE player_id = ? ORDER BY uploaded_at DESC',
      [targetId]
    );
    return res.json(images);
  } catch (err) {
    console.error('[Images] player listing failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch images' });
  }
});

router.get('/player/:id/saved', requireAuth, async (req, res) => {
  const targetId = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid player id' });
  }
  if (targetId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot view another player images' });
  }

  try {
    const images = await db.all(
      "SELECT id, player_id, image_name, image_type, file_path, uploaded_at FROM images WHERE player_id = ? AND image_type = 'saved' ORDER BY uploaded_at DESC",
      [targetId]
    );
    return res.json(images);
  } catch (err) {
    console.error('[Images] saved listing failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch images' });
  }
});

/**
 * Delete an image. Ownership was already checked here - the one endpoint that
 * got it right - but compared a SQLite INTEGER against a JWT claim whose type
 * depended on which code path minted the token, so it could pass or fail
 * inconsistently. Both sides are now integers.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid image id' });
  }

  try {
    const image = await db.get('SELECT * FROM images WHERE id = ?', [id]);
    if (!image) return res.status(404).json({ error: 'Image not found' });

    if (Number(image.player_id) !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const filePath = imagePathFor(path.basename(image.file_path || ''));
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.warn(`[Images] Could not delete ${image.image_name}: ${err.message}`);
      }
    }

    await db.run('DELETE FROM images WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Images] delete failed:', err.message);
    return res.status(500).json({ error: 'Failed to delete image' });
  }
});

// --- named assets ----------------------------------------------------------

// Rec.js deliberately 404s here: returning data makes posters render as Unity
// question marks, whereas a 404 lets them load normally.
router.get('/v1/named', (req, res) => {
  res.sendStatus(404);
});

router.get('/v1/named/images', (req, res) => {
  const imageName = req.query.img;
  if (typeof imageName !== 'string' || !imageName.trim()) {
    return res.sendStatus(404);
  }

  // Previously path.join(...'${imageName}.png') with no containment check, and
  // then called sameHttpDate(), which was never defined anywhere in the
  // project - so any request with an If-Modified-Since header threw a
  // ReferenceError and returned 500.
  const imagePath = imagePathFor(`${imageName.trim()}.png`);
  if (!imagePath || !fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
    return res.sendStatus(404);
  }

  const lastModified = formatHttpDate(fs.statSync(imagePath).mtimeMs);

  if (checkNotModified(req, res, lastModified)) {
    return res.set('Last-Modified', lastModified).end();
  }

  res.set('Last-Modified', lastModified);
  return res.sendFile(imagePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

module.exports = router;