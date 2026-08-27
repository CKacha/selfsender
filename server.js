require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { WebClient } = require('@slack/web-api');
const { parseRecipients, sendToRecipients } = require('./lib/slack');
const tokenStore = require('./lib/tokenStore');
const allowlist = require('./lib/allowlist');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const REDIRECT_URI = `${PUBLIC_BASE_URL}/slack/oauth/callback`;
const BOT_SCOPES = 'chat:write,users:read,users:read.email,im:write,chat:write.customize';
const USER_SCOPES = 'chat:write,users:read,users:read.email,im:write';

// hc login
const HACKCLUB_CLIENT_ID = process.env.HACKCLUB_CLIENT_ID;
const HACKCLUB_CLIENT_SECRET = process.env.HACKCLUB_CLIENT_SECRET;
const ALLOWED_HACKCLUB_EMAIL = (process.env.ALLOWED_HACKCLUB_EMAIL || '').toLowerCase();
const HACKCLUB_AUTH_BASE = 'https://auth.hackclub.com';
const HC_REDIRECT_URI = `${PUBLIC_BASE_URL}/auth/callback`;
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = PUBLIC_BASE_URL.startsWith('https://');

const pendingLogins = new Map();
const sessions = new Map();

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function buildSessionCookie(sid) {
  const parts = [`sid=${sid}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie() {
  const parts = ['sid=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function getSession(req) {
  const sid = getCookie(req, 'sid');
  const session = sid && sessions.get(sid);
  if (!session || Date.now() - session.createdAt >= SESSION_TTL_MS) return null;
  return session;
}

function requireOwner(req, res, next) {
  const session = getSession(req);
  if (session && session.role === 'owner') {
    req.session = session;
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated. Refresh and log in again.' });
  }
  return res.redirect('/login');
}

function requireMember(req, res, next) {
  const session = getSession(req);
  // Re-checked against the live allowlist on every request (not just at
  // login) so removing someone cuts them off immediately.
  if (session && session.role === 'member' && allowlist.list().includes(session.slackUserId)) {
    req.session = session;
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated. Refresh and log in again.' });
  }
  return res.redirect('/team/login');
}

app.get('/login', (req, res) => {
  if (!HACKCLUB_CLIENT_ID) {
    return res.status(500).send('HACKCLUB_CLIENT_ID is not set on the server. See README for setup.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingLogins.set(state, { createdAt: Date.now() });
  const url = new URL(`${HACKCLUB_AUTH_BASE}/oauth/authorize`);
  url.searchParams.set('client_id', HACKCLUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', HC_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'profile email');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Hack Club Auth returned an error: ${error}`);
  }
  const pending = state && pendingLogins.get(state);
  if (!pending || Date.now() - pending.createdAt > LOGIN_STATE_TTL_MS) {
    return res.status(400).send('Login link expired or invalid. Go back to <a href="/login">/login</a> and try again.');
  }
  pendingLogins.delete(state);
  if (!code) {
    return res.status(400).send('Missing code.');
  }

  if (!HACKCLUB_CLIENT_ID || !HACKCLUB_CLIENT_SECRET) {
    return res.status(500).send('HACKCLUB_CLIENT_ID/HACKCLUB_CLIENT_SECRET are not set on the server.');
  }

  try {
    const tokenResp = await fetch(`${HACKCLUB_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: HACKCLUB_CLIENT_ID,
        client_secret: HACKCLUB_CLIENT_SECRET,
        redirect_uri: HC_REDIRECT_URI,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      return res.status(400).send("Hack Club Auth didn't confirm your identity. Please try again.");
    }

    const meResp = await fetch(`${HACKCLUB_AUTH_BASE}/api/v1/me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const me = await meResp.json();
    const email = ((me.identity && me.identity.primary_email) || '').toLowerCase();

    if (!ALLOWED_HACKCLUB_EMAIL || !email || email !== ALLOWED_HACKCLUB_EMAIL) {
      console.warn(`Rejected selfsender login attempt from ${email || '(no email returned)'}`);
      return res.status(403).send('Not authorized. This tool is restricted to a specific account.');
    }

    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { role: 'owner', email, createdAt: Date.now() });
    res.setHeader('Set-Cookie', buildSessionCookie(sid));
    res.redirect('/home');
  } catch (err) {
    res.status(500).send(`Login failed: ${err.message}`);
  }
});

app.get('/logout', (req, res) => {
  const sid = getCookie(req, 'sid');
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.redirect('/');
});
// --- end Hack Club Auth login gate ---------------------------------------

// -team login but honestly just make it slack user gated
const TEAM_REDIRECT_URI = `${PUBLIC_BASE_URL}/team/oauth/callback`;
const pendingTeamLogins = new Map();

app.get('/team/login', (req, res) => {
  if (!process.env.SLACK_CLIENT_ID) {
    return res.status(500).send('SLACK_CLIENT_ID is not set on the server. See README for setup.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingTeamLogins.set(state, { createdAt: Date.now() });
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', process.env.SLACK_CLIENT_ID);
  url.searchParams.set('user_scope', USER_SCOPES);
  url.searchParams.set('redirect_uri', TEAM_REDIRECT_URI);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/team/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Slack returned an error: ${error}`);
  }
  const pending = state && pendingTeamLogins.get(state);
  if (!pending || Date.now() - pending.createdAt > LOGIN_STATE_TTL_MS) {
    return res.status(400).send('Login link expired or invalid. Go back to <a href="/team/login">/team/login</a> and try again.');
  }
  pendingTeamLogins.delete(state);
  if (!code) {
    return res.status(400).send('Missing code.');
  }

  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
    return res.status(500).send('SLACK_CLIENT_ID/SLACK_CLIENT_SECRET are not set on the server.');
  }

  try {
    const client = new WebClient();
    const result = await client.oauth.v2.access({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: TEAM_REDIRECT_URI,
    });

    const slackUserId = result.authed_user && result.authed_user.id;
    const userToken = result.authed_user && result.authed_user.access_token;
    if (!slackUserId || !userToken) {
      return res.status(400).send("Slack didn't return a user token. Try again.");
    }

    if (!allowlist.list().includes(slackUserId)) {
      return res.status(403).send(
        `Not authorized. Ask the admin to add your Slack ID to the allowlist: <strong>${slackUserId}</strong>`
      );
    }

    tokenStore.set(slackUserId, userToken);

    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { role: 'member', slackUserId, createdAt: Date.now() });
    res.setHeader('Set-Cookie', buildSessionCookie(sid));
    res.redirect('/team');
  } catch (err) {
    res.status(500).send(`Login failed: ${err.data?.error || err.message}`);
  }
});
// --- end team member login ------------------------------------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/home', requireOwner, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/team', requireMember, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'team.html'));
});

app.get('/api/allowlist', requireOwner, (req, res) => {
  res.json({ ids: allowlist.list() });
});

app.post('/api/allowlist', requireOwner, (req, res) => {
  const { slackUserId } = req.body || {};
  if (typeof slackUserId !== 'string' || !slackUserId.trim()) {
    return res.status(400).json({ error: 'slackUserId is required.' });
  }
  try {
    const ids = allowlist.add(slackUserId.trim());
    res.json({ ids });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/allowlist/:id', requireOwner, (req, res) => {
  const ids = allowlist.remove(req.params.id);
  tokenStore.remove(req.params.id);
  res.json({ ids });
});

app.post('/api/team/send', requireMember, async (req, res) => {
  const { recipients: recipientsRaw, message, dryRun, delayMs } = req.body || {};

  const token = tokenStore.get(req.session.slackUserId);
  if (!token) {
    return res.status(401).json({ error: 'No stored Slack token for your account. Log in again at /team/login.' });
  }

  if (typeof recipientsRaw !== 'string' || !recipientsRaw.trim()) {
    return res.status(400).json({ error: 'recipients is required (comma-separated Slack IDs or emails).' });
  }
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required.' });
  }

  const recipients = parseRecipients(recipientsRaw);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'No valid recipients found.' });
  }

  try {
    const results = await sendToRecipients({
      token,
      recipients,
      message: message.trim(),
      delayMs: Number(delayMs) > 0 ? Number(delayMs) : 1200,
      dryRun: Boolean(dryRun),
    });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// install for each user
let pendingState = null;

app.get('/slack/install', requireOwner, (req, res) => {
  if (!process.env.SLACK_CLIENT_ID) {
    return res.status(500).send('SLACK_CLIENT_ID is not set on the server. See README for setup.');
  }
  pendingState = crypto.randomBytes(16).toString('hex');
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', process.env.SLACK_CLIENT_ID);
  url.searchParams.set('scope', BOT_SCOPES);
  url.searchParams.set('user_scope', USER_SCOPES);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('state', pendingState);
  res.redirect(url.toString());
});

function updateEnvFile(updates) {
  const envPath = path.join(__dirname, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, nextLines.join('\n'));
}

app.get('/slack/oauth/callback', requireOwner, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Slack returned an error: ${error}`);
  }
  if (!pendingState || state !== pendingState) {
    return res.status(400).send('Invalid or expired state. Start over at /slack/install.');
  }
  pendingState = null;

  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
    return res.status(500).send('SLACK_CLIENT_ID/SLACK_CLIENT_SECRET are not set on the server.');
  }

  try {
    const client = new WebClient();
    const result = await client.oauth.v2.access({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    });

    const botToken = result.access_token;
    const userToken = result.authed_user && result.authed_user.access_token;

    updateEnvFile({
      ...(botToken ? { SLACK_BOT_TOKEN: botToken } : {}),
      ...(userToken ? { SLACK_USER_TOKEN: userToken } : {}),
    });

    res.send(`
      <p>Installed to <strong>${result.team && result.team.name}</strong>.</p>
      <p>Bot token: ${botToken ? 'saved to .env' : 'not granted'}</p>
      <p>User token: ${userToken ? 'saved to .env' : 'not granted'}</p>
      <p><strong>Restart the server</strong> for the new tokens to take effect (dotenv only loads at startup), then close this tab.</p>
    `);
  } catch (err) {
    res.status(500).send(`OAuth exchange failed: ${err.data?.error || err.message}`);
  }
});

app.post('/api/send', requireOwner, async (req, res) => {
  const { recipients: recipientsRaw, message, dryRun, delayMs, tokenType, username, iconEmoji, iconUrl } = req.body || {};

  const asUser = tokenType === 'user';
  const token = asUser ? process.env.SLACK_USER_TOKEN : process.env.SLACK_BOT_TOKEN;
  if (!token) {
    const varName = asUser ? 'SLACK_USER_TOKEN' : 'SLACK_BOT_TOKEN';
    return res.status(500).json({ error: `${varName} is not set on the server.` });
  }

  if (typeof recipientsRaw !== 'string' || !recipientsRaw.trim()) {
    return res.status(400).json({ error: 'recipients is required (comma-separated Slack IDs or emails).' });
  }
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required.' });
  }

  const recipients = parseRecipients(recipientsRaw);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'No valid recipients found.' });
  }

  if ((username || iconEmoji || iconUrl) && asUser) {
    return res.status(400).json({ error: 'username/iconEmoji/iconUrl require tokenType "bot" (Slack only allows per-message name/icon overrides for bot tokens with chat:write.customize).' });
  }

  try {
    const results = await sendToRecipients({
      token,
      recipients,
      message: message.trim(),
      delayMs: Number(delayMs) > 0 ? Number(delayMs) : 1200,
      dryRun: Boolean(dryRun),
      username: username || undefined,
      iconEmoji: iconEmoji || undefined,
      iconUrl: iconUrl || undefined,
    });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`selfsender web UI running at http://localhost:${port}`);
});
