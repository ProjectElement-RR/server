// Webhook support from LunarRec
// Sends notifications to Discord webhooks for server events

let fetch;
try {
  fetch = require('node-fetch');
} catch (e) {
  try {
    fetch = require('node-fetch-commonjs');
  } catch (e2) {
    console.warn('node-fetch not available, webhooks disabled');
    fetch = null;
  }
}

// Configuration - set these in .env
const WEBHOOK_CONSOLE = process.env.WEBHOOK_CONSOLE || '';
const WEBHOOK_REPORTS = process.env.WEBHOOK_REPORTS || '';
const SERVER_ADDRESS = process.env.SERVER_ADDRESS || 'http://localhost:2056';

/**
 * Enum for webhookMessage()
 * @readonly
 * @enum {number}
 */
const dataType = {
  StartUp: 0,
  PlayerOnline: 1,
  PlayerOffline: 2,
  AccountCreate: 3,
  ActivityChange: 4
};

async function webhookMessage(type, data) {
  if (!WEBHOOK_CONSOLE || !fetch) return;

  let embedData = {
    color: 0,
    title: "Title",
    description: "Description",
    icon: `${SERVER_ADDRESS}/cdn/profile/__default.png`
  };

  switch (type) {
    case dataType.StartUp: {
      embedData.color = 35890;
      embedData.title = "Resurge Server Started!";
      embedData.description = null;
    } break;
    case dataType.PlayerOnline: {
      embedData.color = 35890;
      embedData.title = "Player Online!";
      embedData.description = `**${data.username}** is now online!`;
      embedData.icon = `${SERVER_ADDRESS}/cdn/profile/${data.id}.png`;
    } break;
    case dataType.PlayerOffline: {
      embedData.color = 16526123;
      embedData.title = "Player Offline";
      embedData.description = `**${data.username}** is now offline.`;
      embedData.icon = `${SERVER_ADDRESS}/cdn/profile/${data.id}.png`;
    } break;
    case dataType.AccountCreate: {
      embedData.color = 35890;
      embedData.title = "Account Created!";
      embedData.description = `Welcome "**${data.username}**" to Resurge!`;
    } break;
    default: {
      embedData.color = 0;
      embedData.title = `Invalid Data Type provided: \`${type}\``;
      embedData.description = `Data provided: \`${data}\``;
    } break;
  }

  sendWebhook(embedData);
}

/**
 * Enum for sendReport()
 * @readonly
 * @enum {number}
 */
const reportType = {
  General: 0,
  Immature: 1,
  Cheating: 2,
  Harassment: 3,
  Other: -1
};

async function sendReport(type, data) {
  if (!WEBHOOK_REPORTS || !fetch) return;

  try {
    await fetch(WEBHOOK_REPORTS, {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: data })
    });
  } catch (err) {
    console.error('Error sending report webhook:', err);
  }
}

async function sendWebhook(embedData) {
  if (!WEBHOOK_CONSOLE || !fetch) return;

  try {
    await fetch(WEBHOOK_CONSOLE, {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        embeds: [{
          color: embedData.color,
          title: embedData.title,
          description: embedData.description,
          thumbnail: {
            url: embedData.icon,
          },
          footer: {
            text: 'Resurge',
            icon_url: `${SERVER_ADDRESS}/cdn/profile/__default.png`,
          },
          timestamp: new Date()
        }]
      }),
    });
  } catch (err) {
    console.error('Error sending webhook:', err);
  }
}

// Send startup webhook when module loads
webhookMessage(dataType.StartUp, {});

module.exports = { dataType, webhookMessage, sendReport };
