#!/bin/bash
# Double-click to install video-mcp. Runs the same installer as:
#   curl -fsSL https://raw.githubusercontent.com/neelsatyavolu/videomcp/main/install.sh | bash
cd "$HOME" || exit 1
clear
echo "Installing video-mcp — https://videomcp.n3el.dev"
echo
curl -fsSL https://raw.githubusercontent.com/neelsatyavolu/videomcp/main/install.sh | bash
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo "All set. You can close this window and use 'video-mcp' in Terminal."
else
  echo "Install failed (exit $status). Scroll up for the error."
fi
read -n 1 -s -r -p "Press any key to close."
exit "$status"
