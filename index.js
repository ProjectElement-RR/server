const fs = require('fs');
const path = require('path');
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].replace(/#.*$/, '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
      }
    }
  }
} catch (e) {}

const cluster = require('cluster');
const os = require('os');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Multi-threaded setup using Node.js cluster
// Use 4 workers for game API traffic with staggered startup
const numCPUs = 4;

if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  const wsPort = process.env.WS_PORT || 2059;
  const cdnPort = process.env.CDN_PORT || 2058;
  const apiPort = process.env.PORTS || process.env.PORT || '2056';

  console.log(`Resurge Server starting on port: ${apiPort}`);
  console.log(`WebSocket : ws://localhost:${wsPort}`);
  console.log(`CDN       : http://localhost:${cdnPort}/`);

  // The 2017 protocol needs THREE listeners, not just the API (Rec.js does the
  // same): API + WebSocket (presence/heartbeat) + CDN (profile images).
  // These must start ONCE here in the master - starting them per-worker would
  // make every worker after the first fail with EADDRINUSE.
  // This server is 2017-only - no 2018 support.
  require('./lib/wsServer2017').start(wsPort);
  require('./lib/cdn2017').start(cdnPort);

  // Start database cleanup scheduler
  require('./lib/cleanup').startCleanupScheduler();

  // Start memory monitoring
  require('./lib/monitoring').startMemoryMonitoring();

  console.log(`Starting ${numCPUs} worker threads...`);

  // Fork workers with staggered startup (50ms delay between each)
  for (let i = 0; i < numCPUs; i++) {
    setTimeout(() => {
      cluster.fork();
    }, i * 50); // 50ms delay between each worker
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    console.log('Restarting worker in 2 seconds...');
    // Add delay to prevent cascading failures
    setTimeout(() => {
      cluster.fork();
    }, 2000);
  });

  // Graceful shutdown for master
  process.on('SIGTERM', () => {
    console.log('[Master] SIGTERM received, shutting down gracefully');
    for (const id in cluster.workers) {
      cluster.workers[id].kill();
    }
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Master] SIGINT received, shutting down gracefully');
    for (const id in cluster.workers) {
      cluster.workers[id].kill();
    }
    process.exit(0);
  });
} else {
  // Worker process
  console.log(`[Worker ${process.pid}] Starting...`);

  // Start memory monitoring for this worker
  require('./lib/monitoring').startMemoryMonitoring();

  const app = express();

  // Prevent crashes from unhandled rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error(`[Worker ${process.pid}] Unhandled rejection at:`, promise, 'reason:', reason);
  });

  // Prevent crashes from uncaught exceptions
  process.on('uncaughtException', (err) => {
    console.error(`[Worker ${process.pid}] Uncaught exception:`, err);
    console.error(`[Worker ${process.pid}] Stack trace:`, err.stack);
  });

  // The June/July 2017 client is built with a base URL ending in "//"
  // (e.g. https://host//api/...), so requests arrive with a doubled leading
  // slash and Express would 404 them. Collapse runs of slashes in the path.
  app.use((req, res, next) => {
    if (req.url.indexOf('//') !== -1) {
      req.url = req.url.replace(/\/{2,}/g, '/');
    }
    next();
  });

  // 2017-only protocol. Override with PORTS=2056 (or PORT=2056 for just one).
  const PORTS = (process.env.PORTS || process.env.PORT || '2056')
    .split(',')
    .map(p => parseInt(p.trim(), 10))
    .filter(p => Number.isFinite(p) && p > 0);

  // Security middleware
  const corsOrigins = process.env.CORS_ORIGINS || '*';
  const corsOptions = {
    origin: corsOrigins === '*' ? '*' : corsOrigins.split(',').map(o => o.trim()),
    credentials: true
  };
  app.use(cors(corsOptions));

  // Rate limiting
  const rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000');
  const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100');
  const limiter = rateLimit({
    windowMs: rateLimitWindow,
    max: rateLimitMax,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
  });
  app.use('/api/', limiter);

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));

  // Input validation middleware
  const { sanitizeInput } = require('./lib/validation');
  app.use(sanitizeInput);

  // Body parser with size limits
  app.use(bodyParser.json({ limit: '1mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

  // Public endpoints whitelist - these do not require authentication
  // Based on LunarRec and server.2017M for 2017 client compatibility
  const publicEndpoints = [
    /^\/$/,
    /^\/landing$/,
    /^\/cdn\/.*/,
    /^\/img\/.*/,
    /^\/images\/.*/,
    /^\/instance\/.*/,
    /^\/health$/,
    /^\/api\/versioncheck\/.*/,
    /^\/api\/config\/v\d+$/,
    /^\/api\/config\/v\d+\/amplitude$/,
    /^\/api\/platformlogin\/v\d+$/,
    /^\/api\/platformlogin\/v\d+\/.*/,
    /^\/api\/platformlogin\/v\d+\/profiles$/,
    /^\/\/api\/platformlogin\/v\d+$/, // For some 2017 June builds with double slash
    /^\/\/api\/platformlogin\/v\d+\/profiles$/, // For some 2017 June builds with double slash
    /^\/api\/players\/v1\/getorcreate$/,
    /^\/api\/players\/v\d+\/getorcreate$/,
    /^\/api\/launcher\/startup$/,
    /^\/api\/activities\/charades\/v1\/words$/,
    /^\/api\/activities\/.*/,
    /^\/api\/objectives\/v1\/myprogress$/,
    /^\/api\/images\/v.*\/profile$/,
    /^\/api\/images\/v.*\/profile\/.*/,
    /^\/api\/images\/v.*\/named$/,
    /^\/api\/avatar\/v1$/,
    /^\/api\/presence\/v\d+$/,
    /^\/api\/avatar\/v1\/saved$/,
    /^\/api\/avatar\/v2$/,
    /^\/api\/avatar\/v2\/gifts$/,
    /^\/api\/avatar\/v3\/items$/,
    /^\/api\/settings\/v\d+$/,
    /^\/api\/relationships\/v\d+\/get$/,
    /^\/api\/messages\/v\d+\/get$/,
    /^\/api\/equipment\/v\d+\/getUnlocked$/,
    /^\/api\/events\/v.*\/list$/,
    /^\/api\/challenge\/v.*\/getCurrent$/,
    /^\/api\/PlayerReporting\/v\d+\/moderationBlockDetails$/,
    /^\/api\/Notifications\/.*/,
    /^\/api\/presence\/.*/,
    /^\/api\/PlayersBanned\/.*/,
    /^\/api\/match\/.*/,
    /^\/api\/auth\/.*/,
    /^\/api\/playersettings\/.*/,
    /^\/api\/avatarplayersettings\/.*/,
    /^\/api\/versioncheck\/islandedversions$/,
    /^\/api\/gamesessions\/v2\/.*/,
    /^\/api\/gamesessions\/v1\/.*/,
    /^\/api\/PlayerSubscriptions\/v1\/init$/,
    /^\/api\/PlayerSubscriptions\/v1\/add$/,
    /^\/api\/gamesessions\/v2\/joinrandom$/,
    /^\/api\/gamesessions\/v2\/create$/,
    /^\/api\/gamesessions\/v2\/join$/,
    /^\/api\/gamesessions\/v2\/joinroomcode$/,
    /^\/api\/gamesessions\/v2\/listpublicevents$/,
    /^\/api\/gamesessions\/v2\/reportjoinresult$/,
  ];

  // Middleware to check if endpoint is public
  app.use((req, res, next) => {
    const isPublic = publicEndpoints.some(regex => regex.test(req.path));
    req.isPublicEndpoint = isPublic;
    next();
  });

  // Serve static files from public directory
  app.use(express.static(path.join(__dirname, 'public')));

  // Authentication middleware - bypass for public endpoints
  const { optionalAuth } = require('./lib/auth');
  app.use((req, res, next) => {
    if (req.isPublicEndpoint) {
      // For public endpoints, set req.user to null and skip auth
      req.user = null;
      return next();
    }
    return optionalAuth(req, res, next);
  });

  // Serve dashboard CSS and JS at root level for dashboard.html
  app.use('/dashboard.css', express.static(path.join(__dirname, 'public', 'dashboard.css')));
  app.use('/dashboard.js', express.static(path.join(__dirname, 'public', 'dashboard.js')));

  // Log incoming requests (minimal logging for security)
  if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
      console.log(`[Request] ${req.method} ${req.url}`);
      next();
    });
  }

  // API Routes
  const apiRoutes = require('./routes/api');
  const playerRoutes = require('./routes/players');
  const avatarRoutes = require('./routes/avatars');
  const configRoutes = require('./routes/config');
  const imageRoutes = require('./routes/images');
  const gamesessionRoutes = require('./routes/gamesessions');
  const dashboardRoutes = require('./routes/dashboard');
  const leaderboardRoutes = require('./routes/leaderboard');
  const moderationRoutes = require('./routes/moderation');
  const galleryRoutes = require('./routes/gallery');
  const challengeRoutes = require('./routes/challenge');
  const activitiesRoutes = require('./routes/activities');

  // 2017 protocol routes ported from Rec.js / LunarRec
  const platformLoginRoutes = require('./routes/platformlogin');
  const settingsRoutes = require('./routes/settings');
  const relationshipRoutes = require('./routes/relationships');
  const messageRoutes = require('./routes/messages');
  const equipmentRoutes = require('./routes/equipment');
  const eventRoutes = require('./routes/events');
  const reportingRoutes = require('./routes/reporting');
  const subscriptionRoutes = require('./routes/subscriptions');

  app.use('/api', apiRoutes);
  app.use('/api/players', playerRoutes);
  app.use('/api/avatar', avatarRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/images', imageRoutes);
  app.use('/api/gamesessions', gamesessionRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/api/moderation', moderationRoutes);
  app.use('/api/gallery', galleryRoutes);
  app.use('/api/challenge', challengeRoutes);
  app.use('/api/activities', activitiesRoutes);

  app.use('/api/platformlogin', platformLoginRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/relationships', relationshipRoutes);
  app.use('/api/messages', messageRoutes);
  app.use('/api/equipment', equipmentRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api/PlayerReporting', reportingRoutes);
  app.use('/api/PlayerSubscriptions', subscriptionRoutes);

  // LunarRec registers login as '*/api/platformlogin/v*' - some builds prefix the
  // path, so accept any prefix too. The exact mount above still wins first.
  app.use('*/api/platformlogin', platformLoginRoutes);

  // LunarRec serves images from a top-level /img/:id and advertises it as
  // "Images" in its name server. Serve the same shape as a fallback.
  app.get('/img/:id', (req, res) => {
    const id = String(req.params.id || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!id) return res.sendStatus(404);
    // The id may already carry an extension ("/img/ProfileImage.png"). Only
    // append ".png" when there is none, otherwise the path doubles up.
    const name = /\.(png|jpe?g|gif)$/i.test(id) ? id : `${id}.png`;
    const file = path.join(__dirname, 'public', 'images', name);
    if (fs.existsSync(file)) return res.sendFile(file);
    return res.sendStatus(404);
  });

  // Serve uploaded images for website
  app.get('/images/:filename', (req, res) => {
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const file = path.join(__dirname, 'public', 'images', filename);
    if (fs.existsSync(file)) {
      return res.sendFile(file);
    }
    // Return default image if not found
    const defaultFile = path.join(__dirname, 'public', 'images', '__default.png');
    if (fs.existsSync(defaultFile)) {
      return res.sendFile(defaultFile);
    }
    res.sendStatus(404);
  });

  // CDN reachable through the API's own host, for clients arriving via a tunnel
  // that only exposes one port. The standalone CDN port still runs too.
  app.use('/cdn', require('./lib/cdn2017').router);

  // Dashboard route
  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });

  // Download placeholder while the release links are being prepared.
  app.get('/download-in-progress', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Download In Progress | Resurge</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #f4fff7 0%, #dff5e6 100%);
          }
          .card {
            background: #ffffff;
            border: 2px solid #15803d;
            border-radius: 12px;
            padding: 40px;
            max-width: 560px;
            text-align: center;
            box-shadow: 0 10px 30px rgba(21, 128, 61, 0.15);
            color: #1f3d2b;
          }
          h1 {
            color: #15803d;
            margin: 0 0 15px;
          }
          p {
            color: #355443;
            line-height: 1.6;
            margin: 0 0 25px;
          }
          a {
            display: inline-block;
            padding: 12px 24px;
            background: #15803d;
            color: #ffffff;
            text-decoration: none;
            border-radius: 8px;
            font-weight: bold;
          }
          a:hover {
            background: #166534;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Download In Progress</h1>
          <p>The download is still being prepared. Please check back soon.</p>
          <a href="/dashboard">Back to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  });

  // Landing page with link to dashboard
  app.get('/landing', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Resurge</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #f4fff7 0%, #dff5e6 100%);
          }
          .container {
            text-align: center;
            color: #15803d;
            max-width: 800px;
          }
          h1 {
            font-size: 3em;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(21, 128, 61, 0.3);
          }
          .bio {
            max-width: 600px;
            margin: 30px auto;
            color: #355443;
            line-height: 1.6;
            font-style: italic;
          }
          .pronunciation {
            color: #15803d;
            font-weight: bold;
            margin-top: 15px;
            margin-bottom: 30px;
          }
          .features {
            background: #ffffff;
            border: 2px solid #15803d;
            border-radius: 12px;
            padding: 25px;
            margin: 30px 0;
            box-shadow: 0 10px 30px rgba(21, 128, 61, 0.15);
          }
          .features h2 {
            color: #15803d;
            margin-bottom: 20px;
            font-size: 1.5em;
            border-bottom: 2px solid #15803d;
            padding-bottom: 10px;
          }
          .feature-item {
            display: flex;
            align-items: center;
            gap: 15px;
            padding: 15px;
            background: #f0faf3;
            border-radius: 8px;
            margin-bottom: 15px;
            text-align: left;
          }
          .feature-item:last-child {
            margin-bottom: 0;
          }
          .feature-icon {
            font-size: 2em;
            flex-shrink: 0;
          }
          .feature-text {
            color: #355443;
            line-height: 1.5;
          }
          .feature-title {
            color: #15803d;
            font-weight: bold;
            margin-bottom: 5px;
          }
          .rules {
            background: #ffffff;
            border: 2px solid #15803d;
            border-radius: 12px;
            padding: 25px;
            margin: 30px 0;
            box-shadow: 0 10px 30px rgba(21, 128, 61, 0.15);
            text-align: left;
          }
          .rules h2 {
            color: #15803d;
            margin-bottom: 20px;
            font-size: 1.5em;
            border-bottom: 2px solid #15803d;
            padding-bottom: 10px;
            text-align: center;
          }
          .rules-list {
            display: flex;
            flex-direction: column;
            gap: 15px;
          }
          .rule-item {
            display: flex;
            align-items: flex-start;
            gap: 15px;
            padding: 15px;
            background: #f0faf3;
            border-radius: 8px;
            border-left: 4px solid #15803d;
          }
          .rule-item.important {
            border-left-color: #d97706;
            background: #fff7ed;
          }
          .rule-item.warning {
            border-left-color: #eab308;
            background: #fefce8;
          }
          .rule-number {
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 40px;
            height: 40px;
            background: #15803d;
            color: #ffffff;
            border-radius: 50%;
            font-weight: bold;
            font-size: 1em;
            flex-shrink: 0;
          }
          .rule-item.important .rule-number {
            background: #d97706;
          }
          .rule-item.warning .rule-number {
            background: #eab308;
          }
          .rule-text {
            color: #355443;
            line-height: 1.5;
            font-size: 0.95em;
          }
          .landing-actions {
            display: flex;
            justify-content: center;
            gap: 15px;
            flex-wrap: wrap;
            margin-top: 30px;
          }
          .dashboard-link {
            display: inline-block;
            padding: 15px 30px;
            background: #ffffff;
            color: #15803d;
            text-decoration: none;
            border: 2px solid #15803d;
            border-radius: 8px;
            font-weight: bold;
            font-size: 1.2em;
            transition: all 0.3s;
          }
          .dashboard-link:hover {
            background: #15803d;
            color: #ffffff;
            transform: scale(1.05);
          }
          .discord-link {
            background: #15803d;
            color: #ffffff;
          }
          .discord-link:hover {
            background: #166534;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎮 Resurge</h1>
          <div class="bio">
            Resurge focuses on 2017 Rec Room and 2023 Rec Room.
          </div>

          <div class="features">
            <h2>✨ Features</h2>
            <div class="feature-item">
              <div class="feature-icon">🖥️</div>
              <div class="feature-text">
                <div class="feature-title">PC Support</div>
                Full support for PC players with optimized performance and classic 2023 and 2017 gameplay experience.
              </div>
            </div>
            <div class="feature-item">
              <div class="feature-icon">🥽</div>
              <div class="feature-text">
                <div class="feature-title">Quest Support</div>
                Full VR support for Meta Quest devices, bringing the 2023 and 2017 experience to virtual reality.
              </div>
            </div>
            <div class="feature-item">
              <div class="feature-icon">👕</div>
              <div class="feature-text">
                <div class="feature-title">Free Clothing Items</div>
                Access to a wide variety of free clothing items and cosmetics to customize your avatar.
              </div>
            </div>
            <div class="feature-item">
              <div class="feature-icon">🛡️</div>
              <div class="feature-text">
                <div class="feature-title">Active Moderation Team</div>
                Dedicated moderation team ensuring a safe and fun environment for all players.
              </div>
            </div>
          </div>

          <div class="rules">
            <h2>📜 Server Rules</h2>
            <div class="rules-list">
              <div class="rule-item">
                <span class="rule-number">1</span>
                <span class="rule-text">No being an asshole to others in game.</span>
              </div>
              <div class="rule-item">
                <span class="rule-number">2</span>
                <span class="rule-text">No skidding unless given perms to within a private instance where people consented to YOU using your menus/luas etc.</span>
              </div>
              <div class="rule-item">
                <span class="rule-number">3</span>
                <span class="rule-text">No racism, homophobia or being an asshat yet again.</span>
              </div>
              <div class="rule-item">
                <span class="rule-number">4</span>
                <span class="rule-text">Cursing is allowed, just no slurs or things that would be used to harm others using your words in general unless said in a joking matter.</span>
              </div>
              <div class="rule-item">
                <span class="rule-number">5</span>
                <span class="rule-text">No stealing builds or API attacking servers, this can be the general asshole rule yet again.</span>
              </div>
              <div class="rule-item">
                <span class="rule-number">6</span>
                <span class="rule-text">No self promotion outside of the self promo channel.</span>
              </div>
            </div>
          </div>

          <div class="landing-actions">
            <a href="/dashboard" class="dashboard-link">Open Dashboard</a>
            <a href="https://discord.gg/UA4z74Epp" target="_blank" rel="noopener noreferrer" class="dashboard-link discord-link">Join Discord</a>
          </div>
        </div>
      </body>
      </html>
    `);
  });

  // Name server. The 2017 client hits "/" on startup to discover the API host;
  // without it the client cannot resolve any other endpoint.
  // Redirect browsers to landing page, serve JSON to game clients.
  app.get('/', (req, res) => {
    const userAgent = req.get('user-agent') || '';
    // Detect browser requests (not game clients)
    if (userAgent.includes('Mozilla') || userAgent.includes('Chrome') || userAgent.includes('Safari') || userAgent.includes('Edge')) {
      return res.redirect('/landing');
    }
    // Derived from the request, NOT a fixed port: a client that reaches the
    // server on a particular port must be told to keep using that port.
    // Hardcoding one port made the client switch to the wrong one as soon as
    // it followed the name server.
    // Behind a tunnel the Host header is the public name and the scheme is in
    // X-Forwarded-Proto. Using a bare "http://" here would make a client that
    // arrived over https downgrade itself and likely fail.
    const proto =
      (req.get('x-forwarded-proto') || '').split(',')[0].trim() ||
      req.protocol || 'http';
    const host =
      req.get('x-forwarded-host') || req.get('host') || `localhost:${PORTS[0]}`;
    const base = `${proto}://${host}`;
    res.json({
      API: `${base}/api`,
      Auth: `${base}/api`,
      Images: `${base}/api/images`,
      Notifications: `${base}/api`,
      WWW: base
    });
  });

  // Health check with memory stats
  app.get('/health', (req, res) => {
    const { getMemoryStats } = require('./lib/monitoring');
    res.json({
      status: 'ok',
      worker: process.pid,
      memory: getMemoryStats()
    });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('[Error]', err);
    res.status(500).json({ error: err.message });
  });

  // 404 handler
  app.use((req, res) => {
    console.log('[404] Not found:', req.method, req.url);
    res.status(404).json({ error: 'Not found' });
  });

  // One HTTP server per port, each with the WebSocket attached to it (LunarRec
  // style) in addition to the standalone WS port started by the master.
  const ws = require('./lib/wsServer2017');
  PORTS.forEach((port) => {
    const server = app.listen(port, () => {
      console.log(`Worker ${process.pid} listening on port ${port}`);
    });

    // Enable HTTP keep-alive for better connection handling
    server.keepAliveTimeout = 65000; // 65 seconds
    server.headersTimeout = 66000; // Slightly longer than keepAliveTimeout

    server.on('error', (e) => {
      console.error(`[API] Failed to listen on port ${port}: ${e.message}`);
    });
    ws.attach(server, `port ${port}`);
  });

  // Graceful shutdown for workers
  process.on('SIGTERM', () => {
    console.log(`[Worker ${process.pid}] SIGTERM received, shutting down gracefully`);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log(`[Worker ${process.pid}] SIGINT received, shutting down gracefully`);
    process.exit(0);
  });
}
