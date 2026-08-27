require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parseRecipients, sendToRecipients } = require('./lib/slack');

function parseArgs(argv) {
  const args = { dryRun: false, delayMs: 1200, tokenType: 'bot' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--message':
      case '-m':
        args.message = argv[++i];
        break;
      case '--file':
      case '-f':
        args.messageFile = argv[++i];
        break;
      case '--list':
      case '-l':
        args.list = argv[++i];
        break;
      case '--delay-ms':
        args.delayMs = Number(argv[++i]);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--as':
        args.tokenType = argv[++i]; // 'bot' or 'user'
        break;
      case '--username':
        args.username = argv[++i];
        break;
      case '--icon-emoji':
        args.iconEmoji = argv[++i];
        break;
      case '--icon-url':
        args.iconUrl = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function loadMessage(args) {
  if (args.message && args.messageFile) {
    throw new Error('Pass either --message or --file, not both.');
  }
  if (args.messageFile) {
    return fs.readFileSync(path.resolve(args.messageFile), 'utf8').trim();
  }
  if (args.message) {
    return args.message;
  }
  throw new Error('Provide a message with --message "..." or --file path/to/message.txt');
}

function loadRecipients(listPath) {
  if (!listPath) {
    throw new Error('Provide a recipient list with --list path/to/recipients.csv (one email or Slack user ID per line)');
  }
  const raw = fs.readFileSync(path.resolve(listPath), 'utf8');
  return parseRecipients(raw);
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  const message = loadMessage(args);
  const recipients = loadRecipients(args.list);

  if (args.tokenType !== 'bot' && args.tokenType !== 'user') {
    throw new Error('--as must be "bot" or "user"');
  }

  const token = args.tokenType === 'user' ? process.env.SLACK_USER_TOKEN : process.env.SLACK_BOT_TOKEN;
  if (!token) {
    const varName = args.tokenType === 'user' ? 'SLACK_USER_TOKEN' : 'SLACK_BOT_TOKEN';
    throw new Error(`${varName} is not set. Copy .env.example to .env and fill it in.`);
  }

  if ((args.username || args.iconEmoji || args.iconUrl) && args.tokenType !== 'bot') {
    throw new Error('--username/--icon-emoji/--icon-url require --as bot (Slack only allows per-message name/icon overrides for bot tokens with chat:write.customize).');
  }

  console.log(`Preparing to send to ${recipients.length} recipient(s).${args.dryRun ? ' (dry run — nothing will be sent)' : ''}`);
  console.log('--- message preview ---');
  console.log(message);
  console.log('------------------------');

  const results = await sendToRecipients({
    token,
    recipients,
    message,
    delayMs: args.delayMs,
    dryRun: args.dryRun,
    username: args.username,
    iconEmoji: args.iconEmoji,
    iconUrl: args.iconUrl,
    
    onResult: (entry) => {
      if (entry.status === 'failed') {
        console.error(`FAILED -> ${entry.identifier}: ${entry.error}`);
      } else if (entry.status === 'dry-run') {
        console.log(`[dry run] would message ${entry.identifier} (${entry.userId})`);
      } else {
        console.log(`sent -> ${entry.identifier} (${entry.userId})`);
      }
    },
  });

  console.log(`Done. Sent: ${results.sent}, Failed: ${results.failed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
