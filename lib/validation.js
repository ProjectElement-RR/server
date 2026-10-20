function validateId(req, res, next) {
  const id = req.params.id || req.body.id || req.body.player_id;
  if (id && isNaN(parseInt(id))) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  next();
}

function validateUsername(req, res, next) {
  const username = req.body.username || req.body.Name;
  if (username && (typeof username !== 'string' || username.length < 3 || username.length > 32)) {
    return res.status(400).json({ error: 'Username must be between 3 and 32 characters' });
  }
  next();
}

function validateSteamId(req, res, next) {
  const steamId = req.body.steam_id || req.body.platform_id;
  if (steamId && typeof steamId !== 'string') {
    return res.status(400).json({ error: 'Invalid Steam ID format' });
  }
  next();
}

function sanitizeInput(req, res, next) {
  if (req.body) {
    for (const key in req.body) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = req.body[key].trim();
      }
    }
  }
  next();
}

module.exports = {
  validateId,
  validateUsername,
  validateSteamId,
  sanitizeInput
};
