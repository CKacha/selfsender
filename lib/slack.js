const { WebClient } = require('@slack/web-api');

function isSlackUserId(value) {
  return /^[UW][A-Z0-9]{6,}$/.test(value);
}

async function resolveUserId(client, identifier, cache) {
  if (isSlackUserId(identifier)) return identifier;
  if (cache.has(identifier)) return cache.get(identifier);

  const result = await client.users.lookupByEmail({ email: identifier });
  const userId = result.user.id;
  cache.set(identifier, userId);
  return userId;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRecipients(raw) {
  return raw
    .split(/[,\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function sendToRecipients({ token, recipients, message, delayMs = 1200, dryRun = false, onResult, username, iconEmoji, iconUrl }) {
  const client = new WebClient(token);
  const cache = new Map();
  const results = { sent: 0, failed: 0, details: [] };

  for (const identifier of recipients) {
    let entry;
    try {
      const userId = await resolveUserId(client, identifier, cache);

      if (!dryRun) {
        const im = await client.conversations.open({ users: userId });
        const postArgs = { channel: im.channel.id, text: message };
        if (username) postArgs.username = username;
        if (iconEmoji) postArgs.icon_emoji = iconEmoji;
        else if (iconUrl) postArgs.icon_url = iconUrl;
        await client.chat.postMessage(postArgs);
      }

      results.sent += 1;
      entry = { identifier, userId, status: dryRun ? 'dry-run' : 'sent' };
    } catch (err) {
      results.failed += 1;
      entry = { identifier, status: 'failed', error: err.data?.error || err.message };
    }

    results.details.push(entry);
    if (onResult) onResult(entry);

    if (!dryRun) await sleep(delayMs);
  }

  return results;
}

module.exports = { isSlackUserId, resolveUserId, sleep, parseRecipients, sendToRecipients };
