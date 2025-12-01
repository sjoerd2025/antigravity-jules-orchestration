#!/bin/bash
# orchestration/jules-session.sh
# Automate Jules API session creation

set -e

if [ -z "$JULES_API_KEY" ]; then
  echo "Error: JULES_API_KEY is not set."
  exit 1
fi

API_ENDPOINT="https://jules.googleapis.com/v1alpha/sessions"

echo "Creating Jules Session..."

RESPONSE=$(curl -s -X POST "$API_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Goog-Api-Key: $JULES_API_KEY" \
  -d '{
    "name": "auto-session-'$(date +%s)'",
    "type": "standard"
  }')

echo "Response:"
echo "$RESPONSE"

# Extract Session ID (assuming JSON response)
SESSION_ID=$(echo "$RESPONSE" | grep -o '"name": "[^""].*' | cut -d'"' -f4)

if [ ! -z "$SESSION_ID" ]; then
  echo "✅ Session Created: $SESSION_ID"
else
  echo "❌ Failed to create session or parse response."
fi
