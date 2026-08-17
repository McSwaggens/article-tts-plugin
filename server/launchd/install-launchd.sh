#!/bin/sh
# Install a LaunchAgent that starts the TTS server at login, with paths filled
# in for this checkout and this machine.
set -eu

SERVER_DIR=$(cd "$(dirname "$0")/.." && pwd)
UV=$(command -v uv || { echo "error: uv not found on PATH" >&2; exit 1; })
LABEL="com.local-reader-tts.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$UV</string>
    <string>--directory</string>
    <string>$SERVER_DIR</string>
    <string>run</string>
    <string>tts-server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/tts-server.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/tts-server.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed and loaded $PLIST"
echo "logs: ~/Library/Logs/tts-server.log"
