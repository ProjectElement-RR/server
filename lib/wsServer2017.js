// WebSocket server for the 2017 protocol.
//
// Ported from Rec.js servers/shared/WSServer.js. Rec.js starts THREE processes
// for 2017 (API + WS + CDN) - the API alone is not enough. The 2017 client opens
// a WebSocket at startup for presence heartbeats and subscription updates; if
// nothing is listening, presence silently fails and rooms never show as joinable.
const { WebSocketServer } = require('ws');
const sessionManager = require('./sessionManager');

// Response Ids the 2017 client understands (from Rec.js).
const ResponseResults = {
  RelationshipChanged: 1,
  MessageReceived: 2,
  MessageDeleted: 3,
  PresenceHeartbeatResponse: 4,
  SubscriptionListUpdated: 9,
  SubscriptionUpdateProfile: 11,
  SubscriptionUpdatePresence: 12,
  SubscriptionUpdateGameSession: 13,
  SubscriptionUpdateRoom: 15,
  ModerationQuitGame: 20,
  ModerationUpdateRequired: 21,
  ModerationKick: 22,
  ModerationKickAttemptFailed: 23,
  ServerMaintenance: 25,
  GiftPackageReceived: 30,
  ProfileJuniorStatusUpdate: 40,
  RelationshipsInvalid: 50,
  StorefrontBalanceAdd: 60,
  ConsumableMappingAdded: 70,
  ConsumableMappingRemoved: 71,
  PlayerEventCreated: 80,
  PlayerEventUpdated: 81,
  PlayerEventDeleted: 82,
  PlayerEventResponseChanged: 83,
  PlayerEventResponseDeleted: 84,
  PlayerEventStateChanged: 85,
  ChatMessageReceived: 90
};

// Shared so the API can hand the last-created game session to the WS server.
// Store sessions per player ID to support multiple concurrent users
const sessions = new Map();

// Track WebSocket connections per player ID for presence system
const wsConnections = new Map();

function getSession(playerId) {
  return sessions.get(String(playerId));
}

function sessionId(playerId) {
  const s = getSession(playerId);
  if (s && s.GameSessionId != null) return s.GameSessionId;
  return 20171;
}

// Get player ID from WebSocket
function getPlayerIdFromWs(ws) {
  for (const [playerId, connection] of wsConnections.entries()) {
    if (connection === ws) return playerId;
  }
  return null;
}

// Check if player is online
function isPlayerOnline(playerId) {
  return wsConnections.has(String(playerId));
}

// Send message to specific player
function sendToPlayer(playerId, message) {
  const ws = wsConnections.get(String(playerId));
  if (ws && ws.readyState === 1) {
    ws.send(message);
  }
}

// Broadcast presence update to all connected clients
function broadcastPresenceUpdate(playerId) {
  if (!playerId) {
    console.warn('[WS] broadcastPresenceUpdate called with null playerId');
    return;
  }

  const session = getSession(playerId);
  const isOnline = isPlayerOnline(playerId);
  const presenceMsg = JSON.stringify({
    Id: ResponseResults.SubscriptionUpdatePresence,
    Msg: {
      PlayerId: Number(playerId),
      IsOnline: isOnline,
      InScreenMode: false,
      GameSession: session || null
    }
  });

  console.log(`[WS] Broadcasting presence for player ${playerId} (IsOnline: ${isOnline}) to ${wsConnections.size} clients`);

  // Send to all connected clients
  wsConnections.forEach((ws, id) => {
    if (ws.readyState === 1) {
      try {
        ws.send(presenceMsg);
      } catch (e) {
        // Ignore send errors
      }
    }
  });

  // If player is in a session, broadcast presence for all other players in that session
  if (session && session.Players && Array.isArray(session.Players)) {
    console.log(`[WS] Broadcasting presence for ${session.Players.length} players in session`);
    session.Players.forEach(otherPlayerId => {
      if (String(otherPlayerId) !== String(playerId)) {
        const otherSession = getSession(otherPlayerId);
        const otherIsOnline = isPlayerOnline(otherPlayerId);
        const otherPresenceMsg = JSON.stringify({
          Id: ResponseResults.SubscriptionUpdatePresence,
          Msg: {
            PlayerId: Number(otherPlayerId),
            IsOnline: otherIsOnline,
            InScreenMode: false,
            GameSession: otherSession || null
          }
        });

        console.log(`[WS] Broadcasting presence for player ${otherPlayerId} (IsOnline: ${otherIsOnline})`);

        wsConnections.forEach((ws, id) => {
          if (ws.readyState === 1) {
            try {
              ws.send(otherPresenceMsg);
            } catch (e) {
              // Ignore send errors
            }
          }
        });
      }
    });
  }
}

function setSession(playerId, session) {
  sessions.set(String(playerId), session);
  // Broadcast session update to all subscribed clients
  setTimeout(() => broadcastPresenceUpdate(playerId), 0);
}

// Remove session when player disconnects
function removeSession(playerId) {
  sessions.delete(String(playerId));
  // Broadcast offline status
  broadcastPresenceUpdate(playerId);
}

// Track WebSocket connection for a player
function setConnection(playerId, ws) {
  wsConnections.set(String(playerId), ws);
  // Broadcast online status
  broadcastPresenceUpdate(playerId);
}

// Remove WebSocket connection
function removeConnection(playerId) {
  wsConnections.delete(String(playerId));
  // Broadcast offline status
  broadcastPresenceUpdate(playerId);
}

// Set broadcast function in session manager to avoid circular dependency
sessionManager.setBroadcastFn(broadcastPresenceUpdate);

function createResponse(id, playerId) {
  return JSON.stringify({
    Id: id,
    Msg: {
      PlayerId: Number(playerId) || 1,
      IsOnline: true,
      InScreenMode: false,
      GameSession: getSession(playerId) || null
    }
  });
}

function processRequest(data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    return JSON.stringify({ SessionId: 20171 });
  }

  // Rec.js echoes back the requesting player id when present.
  const playerId = parsed.playerId || parsed.PlayerId || 1;

  if (parsed.api != null) {
    if (parsed.api === 'playerSubscriptions/v1/update') {
      return createResponse(ResponseResults.SubscriptionUpdatePresence, playerId);
    }
    if (parsed.api === 'heartbeat2') {
      // Mark the connection as alive when heartbeat is received
      return createResponse(ResponseResults.PresenceHeartbeatResponse, playerId);
    }
    if (parsed.api === 'presence/v1') {
      // Client presence update - acknowledge with proper response
      console.log(`[WS] Presence update from player ${playerId}`);
      return createResponse(ResponseResults.PresenceHeartbeatResponse, playerId);
    }
    console.log(`[WS] Unknown call: "${parsed.api}". Sending blank response`);
    return '';
  }

  return JSON.stringify({ SessionId: sessionId(playerId) });
}

function bind(wss) {
  wss.on('connection', (ws) => {
    console.log('[WS] Client connected!');
    let currentPlayerId = null;

    ws.on('message', (data) => {
      try {
        // Mark connection as alive on any message
        ws.isAlive = true;

        const response = processRequest(data.toString());

        // Track player ID from requests for session management
        try {
          const parsed = JSON.parse(data.toString());
          const newPlayerId = parsed.playerId || parsed.PlayerId || parsed.Msg?.PlayerId;

          // If PlayerId is present, track this connection
          if (newPlayerId) {
            // If this is a new player ID for this connection, update it
            if (newPlayerId !== currentPlayerId) {
              currentPlayerId = newPlayerId;
              setConnection(currentPlayerId, ws);
              console.log(`[WS] Player ${currentPlayerId} connected via WebSocket`);

              // When a player connects, send them presence of all players in their session
              const session = getSession(currentPlayerId);
              if (session && session.Players && Array.isArray(session.Players)) {
                console.log(`[WS] Sending presence for ${session.Players.length} players in session to player ${currentPlayerId}`);
                session.Players.forEach(otherPlayerId => {
                  if (String(otherPlayerId) !== String(currentPlayerId)) {
                    const otherSession = getSession(otherPlayerId);
                    const presenceMsg = JSON.stringify({
                      Id: ResponseResults.SubscriptionUpdatePresence,
                      Msg: {
                        PlayerId: Number(otherPlayerId),
                        IsOnline: isPlayerOnline(otherPlayerId),
                        InScreenMode: false,
                        GameSession: otherSession || null
                      }
                    });
                    ws.send(presenceMsg);
                  }
                });
              }
            }
          }

          // Handle presence updates
          if (parsed.api === 'playerSubscriptions/v1/update' && parsed.param && parsed.param.PlayerIds) {
            console.log(`[WS] Player ${currentPlayerId} subscribing to ${parsed.param.PlayerIds.length} players`);
            parsed.param.PlayerIds.forEach(playerId => {
              const sessionData = getSession(playerId);
              const presenceMsg = JSON.stringify({
                Id: ResponseResults.SubscriptionUpdatePresence,
                Msg: {
                  PlayerId: Number(playerId),
                  IsOnline: isPlayerOnline(playerId),
                  InScreenMode: false,
                  GameSession: sessionData || null
                }
              });
              ws.send(presenceMsg);
            });
          }
        } catch (e) {
          // Ignore parse errors
        }

        ws.send(response);
      } catch (e) {
        console.error(`[WS] Error handling message: ${e.message}`);
      }
    });
    ws.on('error', (err) => {
      console.error(`[WS] WebSocket error: ${err.message}`);
    });
    ws.on('close', () => {
      console.log('[WS] Client disconnected.');
      // Clean up session and connection when player disconnects
      if (currentPlayerId) {
        console.log(`[WS] Player ${currentPlayerId} disconnected`);
        // Also disconnect from session manager
        sessionManager.disconnectPlayer(currentPlayerId);
        // Remove session data (this will broadcast offline status)
        removeSession(currentPlayerId);
        // Remove connection tracking
        removeConnection(currentPlayerId);
        // Force broadcast offline status to all clients
        setTimeout(() => {
          const offlineMsg = JSON.stringify({
            Id: ResponseResults.SubscriptionUpdatePresence,
            Msg: {
              PlayerId: Number(currentPlayerId),
              IsOnline: false,
              InScreenMode: false,
              GameSession: null
            }
          });
          wsConnections.forEach((ws, id) => {
            if (ws && ws.readyState === 1) {
              try {
                ws.send(offlineMsg);
              } catch (e) {
                // Ignore send errors
              }
            }
          });
        }, 100);
      }
    });

    // Set a ping interval to keep connections alive
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });

  // Periodically check for dead connections
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log('[WS] Terminating dead connection');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 120000); // Increased from 30s to 120s (2 minutes) to prevent false disconnects

  // Periodically rebroadcast presence to ensure players stay synchronized
  const rebroadcastInterval = setInterval(() => {
    wsConnections.forEach((ws, playerId) => {
      if (ws && ws.readyState === 1) {
        const session = getSession(playerId);
        if (session && session.Players && Array.isArray(session.Players)) {
          session.Players.forEach(otherPlayerId => {
            if (String(otherPlayerId) !== String(playerId)) {
              const otherSession = getSession(otherPlayerId);
              const presenceMsg = JSON.stringify({
                Id: ResponseResults.SubscriptionUpdatePresence,
                Msg: {
                  PlayerId: Number(otherPlayerId),
                  IsOnline: isPlayerOnline(otherPlayerId),
                  InScreenMode: false,
                  GameSession: otherSession || null
                }
              });
              try {
                ws.send(presenceMsg);
              } catch (e) {
                // Ignore send errors
              }
            }
          });
        }
      }
    });
  }, 10000); // Rebroadcast every 10 seconds (reduced from 5s to reduce network load)

  wss.on('close', () => {
    clearInterval(interval);
    clearInterval(rebroadcastInterval);
  });

  return wss;
}

// Standalone listener on its own port - this is what Rec.js does (ports.WS).
function start(port = process.env.WS_PORT || 2059) {
  let wss;
  try {
    wss = bind(new WebSocketServer({ port: Number(port) }));
  } catch (e) {
    console.error(`[WS] Failed to start on port ${port}: ${e.message}`);
    return null;
  }
  console.log(`[WS] WebSocket server started on port ${port}`);
  return wss;
}

// Attached to an existing HTTP server, so the WebSocket shares the API port.
// LunarRec does it this way (websocket.js is handed the app's own server),
// while Rec.js uses a separate port - support both so either client works.
function attach(server, label) {
  if (!server) return null;
  try {
    bind(new WebSocketServer({ server }));
  } catch (e) {
    console.error(`[WS] Failed to attach to ${label || 'server'}: ${e.message}`);
    return null;
  }
  return server;
}

module.exports = { start, attach, setSession, getSession, removeSession, setConnection, removeConnection, isPlayerOnline, sendToPlayer, broadcastPresenceUpdate, ResponseResults, wsConnections };
