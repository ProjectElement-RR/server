# Security & Resource Updates - Resurge Server

## Summary of Improvements

This document outlines the security hardening and resource management improvements applied to the Resurge Server.

Resurge focuses on 2017-2019 Rec Room.

### 1. JWT Secret Key
- **Before:** Default placeholder key `recroom-2017-server-secret-key-change-in-production`
- **After:** Secure 64-character random key generated using crypto
- **Impact:** Prevents JWT token forgery and unauthorized access

### 2. Security Dependencies Added
- `helmet` - HTTP security headers
- `express-rate-limit` - Rate limiting to prevent DoS attacks

### 3. Security Middleware
- **Helmet Configured:** Added security headers (CSP disabled for 2017 client compatibility)
- **Rate Limiting:** 100 requests per 15 minutes per IP (configurable via .env)
- **CORS Configuration:** Configurable allowed origins via .env (currently set to `*` for compatibility)
- **Input Sanitization:** All string inputs are automatically trimmed

### 4. Request Size Limits
- **Body Parser:** Limited to 1MB for JSON and URL-encoded data
- **Impact:** Prevents memory exhaustion attacks

### 5. Authentication Middleware
- Created `lib/auth.js` with:
  - `authenticateToken` - Requires valid JWT token
  - `optionalAuth` - Optional authentication (doesn't fail if missing)
- Applied to protected routes:
  - Avatar update (`/api/avatar/v2/set`)
  - Game session create/join/leave
  - Player list

### 6. Input Validation
- Created `lib/validation.js` with validators for:
  - ID format validation
  - Username length validation (3-32 characters)
  - Steam ID format validation
- Applied globally via middleware

### 7. Debug Logging
- **Before:** All request headers logged to console
- **After:** Minimal logging only in non-production environments
- **Impact:** Prevents sensitive data leakage in logs

### 8. JWT Token Expiration
- **Before:** 30-day tokens
- **After:** 7-day tokens
- **Impact:** Reduces exposure window if tokens are compromised

### 9. Environment Configuration
Updated `.env` with new security settings:
```env
JWT_SECRET=<secure-random-key>
CORS_ORIGINS=*
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

### 10. Route Security
- Public routes (no auth required):
  - `/api/config/*` - Server configuration
  - `/api/versioncheck/*` - Version validation
  - `/api/players/v1/getorcreate` - Player registration
  - `/api/platformlogin/*` - Platform authentication
  - `/api/avatar/v1` and `/v2` (GET) - Avatar retrieval
  - `/api/avatar/v3/items` - Avatar items
  - `/api/avatar/v2/gifts` - Gifts

- Protected routes (auth required):
  - `/api/avatar/v2/set` - Avatar updates
  - `/api/gamesessions/v1/*` - Game session management
  - `/api/players/v1/list` - Player list

## Resource Management Improvements

### 11. Memory Limits
- **Before:** No memory limit - Node.js could consume all available RAM
- **After:** 2GB heap size limit via `--max-old-space-size=2048`
- **Impact:** Prevents server from crashing system due to memory exhaustion
- **Config:** `NODE_MAX_OLD_SPACE_SIZE=2048` in .env

### 12. Database Cleanup
- **Before:** No cleanup - game sessions accumulated indefinitely
- **After:** Automatic cleanup of old game sessions (24-hour retention)
- **Impact:** Prevents database from growing unbounded
- **Config:**
  - `CLEANUP_INTERVAL_MS=3600000` (1 hour)
  - `GAME_SESSION_RETENTION_HOURS=24`
- **Features:**
  - Runs hourly cleanup of old sessions
  - Daily VACUUM to reclaim disk space
  - Automatic startup cleanup

### 13. Memory Monitoring
- **Before:** No memory monitoring
- **After:** Real-time memory usage tracking with alerts
- **Impact:** Early detection of memory leaks and high usage
- **Config:**
  - `MEMORY_CHECK_INTERVAL_MS=60000` (1 minute)
  - `MEMORY_WARNING_THRESHOLD_MB=1024` (1GB)
  - `MEMORY_CRITICAL_THRESHOLD_MB=1536` (1.5GB)
- **Features:**
  - Logs heap usage every minute
  - Warning at 1GB usage
  - Critical alert at 1.5GB usage
  - Memory stats exposed in `/health` endpoint

### New Files Created
- `lib/cleanup.js` - Database cleanup scheduler
- `lib/monitoring.js` - Memory monitoring system

### Modified Files
- `package.json` - Added memory limit flag to start scripts
- `start.bat` - Added memory limit flag
- `index.js` - Integrated cleanup and monitoring
- `.env` - Added resource limit configuration

## Health Endpoint

The `/health` endpoint now returns memory statistics:
```json
{
  "status": "ok",
  "worker": 12345,
  "memory": {
    "heapUsed": "512.00 MB",
    "heapTotal": "1024.00 MB",
    "external": "45.00 MB",
    "rss": "600.00 MB"
  }
}
```

## Remaining Recommendations

For production deployment, consider:

1. **HTTPS:** Use a reverse proxy (nginx/traefik) with TLS
2. **CORS:** Set specific allowed origins instead of `*`
3. **Photon Credentials:** Rotate the exposed Photon app IDs
4. **Database Encryption:** Consider SQLCipher for at-rest encryption
5. **Monitoring:** Add intrusion detection and logging
6. **IP Whitelisting:** Restrict access to known client IPs if possible
7. **CSRF Protection:** Add CSRF tokens for state-changing operations

## Testing

To test the security improvements:

1. Start the server: `npm start`
2. Test rate limiting: Make >100 requests in 15 minutes
3. Test authentication: Try accessing protected routes without a token
4. Test input validation: Send malformed IDs or usernames

## Rollback

If any issues arise, the changes can be reverted by:

### Security Features
1. Removing the security middleware from `index.js`
2. Removing `authenticateToken` from routes
3. Restoring the old JWT secret in `.env`

### Resource Management
1. Remove `--max-old-space-size=2048` from `package.json` and `start.bat`
2. Comment out cleanup and monitoring requires in `index.js`
3. Remove new config variables from `.env`
4. Delete `lib/cleanup.js` and `lib/monitoring.js`
