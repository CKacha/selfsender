const fs = require('fs');
const path = require('path');
const { isSlackUserId } = require('./slack');

const ALLOWLIST_FILE = path.join(__dirname, '..', 'team-allowlist.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

let ids = load();

function save() {
  fs.writeFileSync(ALLOWLIST_FILE, JSON.stringify(ids, null, 2));
}

function list() {
  return [...ids];
}

function add(slackUserId) {
  if (!isSlackUserId(slackUserId)) {
    throw new Error(`"${slackUserId}" doesn't look like a Slack user ID (e.g. U0123ABCD).`);
  }
  if (!ids.includes(slackUserId)) {
    ids.push(slackUserId);
    save();
  }
  return list();
}

function remove(slackUserId) {
  ids = ids.filter((id) => id !== slackUserId);
  save();
  return list();
}

module.exports = { list, add, remove };
