# Resurge Server

Multi-threaded Rec Room 2017 server built with Node.js, Express, and SQLite.

Resurge focuses on 2017 Rec Room.

## Features

- **Multi-threaded**: Uses Node.js cluster to spawn multiple worker processes for handling concurrent connections
- **2017-Only Protocol**: Implements the core API endpoints for Rec Room 2017 clients only
- **SQLite Database**: Lightweight database for player data, avatars, settings, and game sessions
- **JWT Authentication**: Secure session token generation and validation
- **Advanced Image System**: Sharecam, profile pictures, gallery with HTTP caching
- **Game Sessions**: Create, join, and leave game sessions
- **Avatar System**: Save and load avatar data
- **Memory Optimization**: Automatic garbage collection and monitoring
- **Rec-Room-Patches Compatible**: Matches 2017 API behavior (Last-Modified, 304 responses, etc.)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Set environment variables (optional):
```bash
set JWT_SECRET=your-secret-key
set PORTS=2056
set WS_PORT=2059
set CDN_PORT=2058
```

## Usage

Start the server:
```bash
npm start
```

The server will start on main port 2056 (2017-only) with:
- API Server: Port 2056
- WebSocket Server: Port 2059
- CDN Server: Port 2058
- All three services are also reachable through the main API port (WebSocket is attached to it and the CDN is served under `/cdn`)
- 4 worker processes for handling concurrent connections

## API Endpoints

### Config
- `GET /api/config/v2` - Server configuration
- `GET /api/config/v1/amplitude` - Amplitude config

### Players
- `POST /api/players/v1/getorcreate` - Get or create player
- `POST /api/players/v1/list` - List players
- `POST /api/platformlogin/v1` - Platform login

### Avatars
- `GET /api/avatar/v2` - Get avatar data
- `POST /api/avatar/v2/set` - Set avatar data
- `GET /api/avatar/v3/items` - Get avatar items
- `GET /api/avatar/v2/gifts` - Get gifts
- `POST /api/avatar/v2/gifts/consume/` - Consume gift

### Images (2017 Protocol)
- `GET /api/images/v1/profile/:id` - Get profile image (with Last-Modified and 304 support)
- `POST /api/images/v*/profile` - Upload profile image (204 No Content response)
- `POST /api/images/v*/uploadtransient` - Sharecam transient images
- `POST /api/images/v*/uploadsaved` - Sharecam saved images
- `GET /api/images/v1/named` - Named images (returns 404)
- `GET /api/images/v1/named/images?img=<name>` - Custom poster images

### Images (Website)
- `GET /api/gallery` - Public image gallery (saved images only)
- `GET /api/images/player/:id` - Player's all images
- `GET /api/images/player/:id/saved` - Player's saved images only
- `POST /api/images/upload/cloud` - Upload image to gallery
- `POST /api/images/upload/profile` - Upload profile image from website

### Game Sessions
- `GET /api/gamesessions/v1/` - Get game sessions
- `POST /api/gamesessions/v1/` - Create game session
- `POST /api/gamesessions/v1/join` - Join game session
- `POST /api/gamesessions/v1/leave` - Leave game session

### Other
- `GET /api/versioncheck/v1` - Version check
- `GET /api/launcher/startup` - Launcher startup
- `POST /api/presence/v1/list` - Presence list
- `POST /api/presence/v2` - Presence v2
- `GET /api/objectives/v1/myprogress` - Objectives progress
- `POST /api/activities/charades/v1/words` - Charades words

## Database Schema

### Players
- id (INTEGER, PRIMARY KEY)
- username (TEXT, UNIQUE)
- steam_id (TEXT)
- created_at (TEXT)
- xp (INTEGER)
- level (INTEGER)
- session_token (TEXT)
- is_banned (INTEGER)

### Avatars
- id (INTEGER, PRIMARY KEY)
- player_id (INTEGER, FOREIGN KEY)
- avatar_data (TEXT)
- updated_at (TEXT)

### Settings
- id (INTEGER, PRIMARY KEY)
- player_id (INTEGER, FOREIGN KEY)
- settings_data (TEXT)
- updated_at (TEXT)

### Game Sessions
- id (INTEGER, PRIMARY KEY)
- room_id (TEXT)
- room_name (TEXT)
- host_id (INTEGER, FOREIGN KEY)
- players (TEXT)
- is_private (INTEGER)
- max_players (INTEGER)
- created_at (TEXT)

### Friends
- id (INTEGER, PRIMARY KEY)
- player_id (INTEGER, FOREIGN KEY)
- friend_id (INTEGER, FOREIGN KEY)
- status (TEXT)
- created_at (TEXT)

### Images
- id (INTEGER, PRIMARY KEY)
- player_id (INTEGER, FOREIGN KEY)
- image_name (TEXT)
- image_type (TEXT) - 'profile', 'saved', 'transient', 'shared.profile_image'
- file_path (TEXT)
- uploaded_at (TEXT)

## License

MIT
