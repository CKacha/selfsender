# Integrating selfsender into another project/agent

This tool sends Slack DMs (as a bot or as your own user account) to a list
of recipients. The reusable logic lives in `lib/slack.js` and has no
dependency on the CLI (`app.js`) or the web server (`server.js`) — you can
`require()` it directly from another Node project.

## Required Slack permissions (OAuth scopes)

Grant these on the Slack app at api.slack.com/apps, under **OAuth & Permissions**.

**Bot Token Scopes** (for `SLACK_BOT_TOKEN`, `xoxb-...`):
- `chat:write`
- `users:read`
- `users:read.email`
- `im:write`
- `chat:write.customize` — only needed if you'll override the bot's
  display name/icon per-send (`username`/`iconEmoji`/`iconUrl`)

**User Token Scopes** (for `SLACK_USER_TOKEN`, `xoxp-...`) — only needed if
you want to send as a real human account instead of the bot:
- `chat:write`
- `im:write`
- `users:read`
- `users:read.email`

A user token automates a real Slack account — different trust boundary
than a bot. Only point it at a workspace you control/own the account in.

## Required environment variables

At minimum, one of:
- `SLACK_BOT_TOKEN` (`xoxb-...`) — for sending as the bot
- `SLACK_USER_TOKEN` (`xoxp-...`) — for sending as yourself

Neither `lib/slack.js` function reads `process.env` directly — the calling
code passes a `token` in. So the host project can source these tokens
however it likes (its own `.env`, a secrets manager, etc.) rather than
relying on this repo's `.env` file.

## Programmatic API (`lib/slack.js`)

```js
const { parseRecipients, sendToRecipients } = require('./path/to/selfsender/lib/slack');
```

### `parseRecipients(raw: string): string[]`

Splits a comma/newline-separated blob into a clean list of identifiers
(emails or Slack user IDs), trimming whitespace and dropping empty lines
and `#`-prefixed comment lines.

### `sendToRecipients(options): Promise<Results>`

```js
const results = await sendToRecipients({
  token,               // required: xoxb-... or xoxp-... token
  recipients,          // required: string[] of emails and/or Slack user IDs (e.g. "U0123ABCD")
  message,             // required: string, the DM text
  delayMs,             // optional: ms to wait between sends, default 1200
  dryRun,              // optional: boolean, resolve recipients but send nothing, default false
  username,            // optional: bot display name override (bot token only, needs chat:write.customize)
  iconEmoji,           // optional: bot icon override, e.g. ":wave:" (bot token only)
  iconUrl,             // optional: bot icon override via URL (bot token only, ignored if iconEmoji set)
  onResult,            // optional: (entry) => void, called after each send/failure for live progress
});
```

Returns:

```js
{
  sent: number,
  failed: number,
  details: [
    { identifier, userId, status: 'sent' | 'dry-run' },
    { identifier, status: 'failed', error: string },
    // ...
  ],
}
```

Behavior notes:
- Each `identifier` in `recipients` can be an email or a raw Slack user ID
  (`U.../W...`) — emails are resolved via `users.lookupByEmail` and cached
  per call, so `SLACK_TOKEN` needs the `users:read.email` scope if you pass
  emails.
- Sends are sequential with a `delayMs` pause between each (no `sleep` when
  `dryRun` is true), so a large recipient list will take
  `recipients.length * delayMs` to complete — plan timeouts accordingly if
  calling this from a request handler or a job with its own time limit.
- `username`/`iconEmoji`/`iconUrl` only work with a bot token — Slack
  rejects per-message identity overrides on user tokens; the caller is
  responsible for not passing these with a user token (the CLI/web layer
  enforce this, but `sendToRecipients` itself does not).
- Throws only if `resolveUserId`/`conversations.open`/`chat.postMessage`
  reject in a way not caught per-recipient — in practice, per-recipient
  failures are caught and reported in `details`/`onResult` rather than
  rejecting the whole call.

## Minimal integration example

```js
const { parseRecipients, sendToRecipients } = require('./selfsender/lib/slack');

const recipients = parseRecipients('alice@example.com, U0123ABCD\nbob@example.com');

const results = await sendToRecipients({
  token: process.env.MY_APP_SLACK_BOT_TOKEN,
  recipients,
  message: 'Deploy finished successfully.',
  dryRun: false,
  onResult: (entry) => console.log(entry),
});

console.log(`sent ${results.sent}, failed ${results.failed}`);
```

## Other ways to invoke it instead of importing the module

- CLI: `node app.js --message "..." --list recipients.csv [--as bot|user] [--dry-run]`
- HTTP: run `node server.js` and `POST /api/send` with JSON body
  `{ recipients, message, dryRun, delayMs, tokenType, username, iconEmoji, iconUrl }`
  (see `server.js` for the full contract) — useful if the other project
  isn't Node, or you'd rather call this over HTTP than vendor the code.
