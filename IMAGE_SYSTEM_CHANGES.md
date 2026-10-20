# Image System Improvements - Summary

## Overview
This document summarizes the improvements made to the Resurge server's image system, incorporating features from LunarRec, server.2017M, and Rec-Room-Patches to support Sharecam, RecNet images, and profile pictures.

**Note**: This server is now 2017-ONLY. All 2018 support has been removed.

## Changes Made

### 1. Sharecam/RecNet Image Endpoints
Added two new endpoints to support the 2017 client's Sharecam feature:

- **POST /api/images/v*/uploadtransient**: Upload temporary images (not saved to gallery)
- **POST /api/images/v*/uploadsaved**: Upload saved images (stored in player's gallery)

These endpoints match the behavior of server.2017M and LunarRec, allowing players to take photos in-game and share them.

**Note**: The `/sendlink` endpoint was removed as it's not part of the standard 2017 protocol.

### 2. Unity Texture Header Stripping
Implemented automatic removal of Unity texture headers (141 bytes) from uploaded images:

```javascript
function stripUnityHeader(buffer) {
  if (buffer.length > 141) {
    return buffer.slice(141);
  }
  return buffer;
}
```

This is applied to all image uploads to ensure compatibility with the 2017 client's image format.

### 3. UUID-Based Image Naming
Changed from player ID-based naming to UUID-based naming for unique image identification:

- Profile images: Still use `{playerId}.png` for CDN compatibility
- Sharecam images: Use `{uuid}.png` for uniqueness
- Database tracks both the UUID and player ID

This prevents naming conflicts and allows players to have multiple images.

### 4. Enhanced Database Integration
- Added `profile_image` column to players table to track current profile picture
- Updated images table to support multiple image types: 'profile', 'saved', 'transient', 'cloud'
- Profile image uploads now update both the images table and players table

### 5. CDN Improvements
Enhanced the CDN to support both naming schemes:

- `/cdn/image/{uuid}.png` - UUID-based Sharecam images
- `/cdn/profile/{playerId}.png` - Player ID-based profile images
- Fallback to default image for missing files

### 6. Memory Optimization
Enhanced memory monitoring to prevent leaks:

- Added automatic garbage collection triggers at configurable thresholds
- Configurable memory thresholds (warning, critical, GC)
- Memory stats available via `/health` endpoint
- Workers can trigger GC when memory is high

### 7. Image Cleanup System
Added automated cleanup to prevent disk space issues:

- Deletes old transient images (configurable retention period, default 30 days)
- Removes orphaned image files (files without database records)
- Runs on configurable interval (default 1 hour)
- Integrated with existing database cleanup system

### 8. Gallery Filtering
Updated gallery routes to exclude transient images:

- Gallery now only shows 'saved' and 'profile' images
- Prevents temporary screenshots from cluttering the public gallery
- Player's personal gallery still shows all their images

## Configuration

Add these environment variables to `.env` to customize behavior:

```env
# Server Ports (2017-Only)
PORTS=2056
WS_PORT=2059
CDN_PORT=2058

# Image retention
IMAGE_RETENTION_DAYS=30

# Memory thresholds (in MB)
MEMORY_WARNING_THRESHOLD_MB=1024
MEMORY_CRITICAL_THRESHOLD_MB=1536
MEMORY_GC_THRESHOLD_MB=1200

# Cleanup intervals
CLEANUP_INTERVAL_MS=3600000
MEMORY_CHECK_INTERVAL_MS=60000

# CDN configuration
CDN_PORT=2058
CDN_BASE_URI=http://localhost:2058
```

## API Endpoints

### Profile Images
- `GET /api/images/v1/profile/:id` - Get player's profile image
- `POST /api/images/v*/profile` - Upload profile image (game client)
- `POST /api/images/upload/profile` - Upload profile image (website)

### Sharecam Images
- `POST /api/images/v*/uploadtransient` - Upload temporary image
- `POST /api/images/v*/uploadsaved` - Upload saved image

### Gallery
- `GET /api/gallery` - Get public gallery (saved + profile images only)
- `GET /api/gallery/player/:id` - Get player's personal gallery

### CDN
- `GET /cdn/image/:imagename` - Get Sharecam image by UUID
- `GET /cdn/profile/:id` - Get profile image by player ID
- `GET /cdn/*` - Fallback CDN endpoint

### Named Images
- `GET /api/images/v1/named` - Returns 404 (standard behavior)
- `GET /api/images/v1/named/images?img=<name>` - Get custom poster image by name

## Testing

The server has been tested and confirmed to:
- Start successfully with all workers
- Initialize database with new columns
- Clean up orphaned image files on startup
- Run memory monitoring on all workers
- Serve CDN on port 2058 (also routed through the main API port under `/cdn`)
- Serve API on port 2056

## Performance Improvements

1. **Multi-threaded Architecture**: 4 worker processes handle API traffic
2. **WAL Mode**: SQLite WAL mode enabled for better concurrency
3. **Connection Pooling**: Keep-alive timeouts optimized
4. **Memory Management**: Automatic GC triggers and monitoring
5. **Cleanup Automation**: Prevents disk space and memory bloat

## Compatibility

- Maintains backward compatibility with existing player ID-based profile images
- Supports both 2017 and 2018 client builds
- Compatible with CDN tunneling (single port deployments)
- Matches LunarRec and server.2017M protocol expectations
- Now includes Rec-Room-Patches 2017 API compatibility:
  - Purpose-based image organization (e.g., "shared.profile_image")
  - Last-Modified headers with 304 Not Modified support
  - Magic byte detection for image type validation
  - Proper HTTP date formatting
  - 204 No Content responses for successful uploads

## Future Enhancements

Potential improvements for future versions:

- Add image compression/re sizing on upload
- Implement image moderation system
- Add image metadata (location, timestamp, etc.)
- Support for additional image formats
- Cloud storage integration (S3, etc.)
- Image analytics and usage tracking
