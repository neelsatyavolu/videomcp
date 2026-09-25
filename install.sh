#!/usr/bin/env bash
# video-mcp installer.
#
#   curl -fsSL https://raw.githubusercontent.com/neelsatyavolu/videomcp/main/install.sh | bash
#
# Installs the latest release of video-mcp (a global npm package), then its tools:
# ffmpeg, tesseract, whisper-cpp and a speech model, via Homebrew.
# Nothing else on your machine is changed; agent configs are only touched if you
# later run `video-mcp install`.
#
# Environment:
#   VIDEO_MCP_TARBALL=<url|path>  install this package instead of the latest release
#   VIDEO_MCP_SKIP_SETUP=1        skip installing ffmpeg / whisper / tesseract

set -euo pipefail

REPO="neelsatyavolu/videomcp"
TARBALL="${VIDEO_MCP_TARBALL:-https://github.com/$REPO/releases/latest/download/video-mcp-server.tgz}"
MIN_NODE=18

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

load_brew() {
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
    if [ -x "$b" ]; then
      eval "$("$b" shellenv)"
      return 0
    fi
  done
  return 1
}

ensure_brew() {
  have brew || load_brew || true
  have brew && return 0
  [ "$(uname -s)" = "Darwin" ] || fail "Homebrew not found. Install ffmpeg, tesseract and whisper-cpp yourself, then rerun with VIDEO_MCP_SKIP_SETUP=1."
  [ -r /dev/tty ] || fail "Homebrew is required. Install it from https://brew.sh and run this again."
  bold "Installing Homebrew (needed for ffmpeg and speech-to-text). It will ask for your password."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  load_brew || fail "Homebrew installed, but brew was not found. Open a new terminal and run this again."
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node() {
  if have node && [ "$(node_major)" -ge "$MIN_NODE" ]; then return 0; fi
  if have brew || load_brew; then
    bold "Installing Node.js with Homebrew…"
    brew install node
  else
    fail "Node.js $MIN_NODE or newer is required. Install it from https://nodejs.org and run this again."
  fi
  [ "$(node_major)" -ge "$MIN_NODE" ] || fail "Node.js $MIN_NODE+ is required (found $(node -v 2>/dev/null || echo none))."
}

install_package() {
  bold "Installing video-mcp…"
  local prefix
  prefix="$(npm prefix -g)"
  if [ -w "$prefix/lib/node_modules" ] || { [ ! -e "$prefix/lib/node_modules" ] && [ -w "$prefix" ]; }; then
    npm install -g --no-fund --no-audit "$TARBALL"
  else
    # System Node (e.g. the nodejs.org installer) needs sudo for global installs; use ~/.local instead.
    npm install -g --no-fund --no-audit --prefix "$HOME/.local" "$TARBALL"
    export PATH="$HOME/.local/bin:$PATH"
    case ":$(printf '%s' "${ORIGINAL_PATH:-}"):" in
      *":$HOME/.local/bin:"*) ;;
      *) note "Add this to your shell profile so 'video-mcp' is found: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac
  fi
  have video-mcp || fail "video-mcp was installed but is not on PATH."
}

main() {
  ORIGINAL_PATH="$PATH"
  case "$(uname -s)" in
    Darwin) ;;
    Linux) note "Linux support is untested; continuing." ;;
    *) fail "video-mcp supports macOS (and, untested, Linux)." ;;
  esac

  if [ "${VIDEO_MCP_SKIP_SETUP:-}" != "1" ]; then ensure_brew; fi
  ensure_node
  install_package

  if [ "${VIDEO_MCP_SKIP_SETUP:-}" != "1" ]; then
    bold "Installing ffmpeg, tesseract and whisper-cpp (skips what you already have)…"
    video-mcp setup
  fi

  echo
  bold "video-mcp $(video-mcp version) is installed."
  note "Sorting needs one of these agent CLIs, signed in: Claude Code, Codex, or Grok."
  echo
  note "Try it:        video-mcp sort ~/Footage/my-shoot --dry-run"
  note "Sort for real: video-mcp sort ~/Footage/my-shoot"
  note "Undo:          video-mcp sort --undo ~/Footage/my-shoot"
  note "MCP server:    video-mcp install   (adds video tools to Claude, Codex and Grok)"
}

# Everything runs from main, so a partially downloaded script does nothing.
main "$@"
