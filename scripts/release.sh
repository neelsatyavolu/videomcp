#!/usr/bin/env bash
# Builds the release assets and publishes a GitHub release for the version in package.json.
#   scripts/release.sh            build + publish
#   scripts/release.sh --dry-run  build only (assets land in release/)
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(node -p 'require("./package.json").version')"
tag="v$version"
out="release"

[ -z "$(git status --porcelain)" ] || { echo "Working tree is not clean." >&2; exit 1; }
npm run -s typecheck
npm test --silent
npm run -s build

mkdir -p "$out"
tgz="$(npm pack --silent --pack-destination "$out")"
# Stable name so releases/latest/download/video-mcp-server.tgz always works.
mv "$out/$tgz" "$out/video-mcp-server.tgz"

stage="$(mktemp -d)"
cp "scripts/Install video-mcp.command" "$stage/"
chmod +x "$stage/Install video-mcp.command"
rm -f "$out/Install-video-mcp.zip"
# ditto keeps the executable bit, which a plain download of a .command would lose.
ditto -c -k --keepParent "$stage/Install video-mcp.command" "$out/Install-video-mcp.zip"
rm -r "$stage"

ls -l "$out"
[ "${1:-}" = "--dry-run" ] && exit 0

gh release create "$tag" "$out/video-mcp-server.tgz" "$out/Install-video-mcp.zip" \
  --title "video-mcp $version" \
  --notes "Install: \`curl -fsSL https://raw.githubusercontent.com/neelsatyavolu/videomcp/main/install.sh | bash\` — or download **Install-video-mcp.zip**, unzip, and double-click. See https://videomcp.n3el.dev"
