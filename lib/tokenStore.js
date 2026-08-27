const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, '..', 'slack-tokens.json');

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

let tokens = loadTokens();

function get(slackUserId) {
  return tokens[slackUserId];
}

function set(slackUserId, token) {
  tokens[slackUserId] = token;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function remove(slackUserId) {
  delete tokens[slackUserId];
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

module.exports = { get, set, remove };
