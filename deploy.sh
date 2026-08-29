#!/bin/bash
set -e
cd /home/ck/selfsender

/usr/bin/git fetch origin main --quiet

LOCAL=$(/usr/bin/git rev-parse HEAD)
REMOTE=$(/usr/bin/git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "$(date): new commits detected ($LOCAL -> $REMOTE), deploying..."
  /usr/bin/git pull origin main --quiet
  /usr/bin/npm install --silent
  sudo -n /usr/bin/systemctl restart selfsender
  echo "$(date): deploy complete"
fi
