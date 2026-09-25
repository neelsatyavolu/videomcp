# video-mcp

**Sort a shoot folder in one command** — A-roll vs B-roll, grouped by topic, bad takes pulled into
`_rejects` — plus a **local-first video understanding MCP** for Claude Desktop, Claude Code, Codex,
Grok, and any MCP client. → [videomcp.n3el.dev](https://videomcp.n3el.dev)

## Install (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/neelsatyavolu/videomcp/main/install.sh | bash
```

Or [download the Mac installer](https://github.com/neelsatyavolu/videomcp/releases/latest/download/Install-video-mcp.zip),
unzip it and double-click **Install video-mcp.command**. Either way it installs Node.js and Homebrew
if missing, the `video-mcp` command, and ffmpeg, tesseract, whisper-cpp and a speech model
([install.sh](install.sh) is short — read it first if you like). Sorting also needs one of the
Claude Code, Codex or Grok CLIs, signed in.

The MCP server turns video into what agents already understand: **metadata + timestamped
transcript + key frames + timeline**. The sections below cover it and other ways to install.

## Other install options

**Prerequisites:** Node.js 18+ and [ffmpeg](https://ffmpeg.org/) (`brew install ffmpeg`).

### From a clone

```bash
git clone https://github.com/neelsatyavolu/videomcp && cd videomcp
npm install && npm run build
node dist/index.js setup      # ffmpeg + tesseract + whisper-cpp + model
node dist/index.js install    # Claude Desktop / Code / Codex / Grok
```

### Global npm install (from the latest release)

```bash
npm install -g https://github.com/neelsatyavolu/videomcp/releases/latest/download/video-mcp-server.tgz
video-mcp setup            # ffmpeg / tesseract / whisper-cpp + model
video-mcp install          # all clients
video-mcp doctor           # check ffmpeg / Whisper / installs
```

### Use as an MCP server

`video-mcp install` wires **Claude Desktop**, **Claude Code**, **Codex**, and **Grok** automatically. Restart the app / start a new agent session after installing.

```bash
video-mcp install --client desktop   # Claude Desktop only
video-mcp install --client code      # Claude Code only
video-mcp install --client codex
video-mcp install --client grok
video-mcp install --client all       # default

video-mcp status
video-mcp uninstall
video-mcp help
```

## CLI

| Command | What it does |
|---------|----------------|
| `video-mcp setup` | Install **needed** deps: ffmpeg, tesseract, whisper-cpp + ggml model |
| `video-mcp install` | Add MCP to agent config files |
| `video-mcp uninstall` | Remove from configs |
| `video-mcp status` | Show where it's installed |
| `video-mcp doctor` | ffmpeg / whisper / tesseract + client status |
| `video-mcp sort <folder>` | Sort a shoot folder by topic, A/B roll and quality (see below) |
| `video-mcp serve` | Run MCP on stdio (also the default with no args) |

### Needed system tools

| Tool | Role |
|------|------|
| **ffmpeg** | Frames, probe, audio |
| **whisper-cpp** + **ggml-base.bin** | Local speech-to-text |
| **tesseract** | On-screen text (OCR) |
| yt-dlp | YouTube/etc. (optional) |

Configs are updated in place; a `.bak` backup is written first.

| Client | Config file |
|--------|-------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Code | `~/.claude.json` |
| Codex | `~/.codex/config.toml` |
| Grok | `~/.grok/config.toml` |

## Sorting a shoot folder

```bash
video-mcp sort ~/Footage/shoot-0924 --dry-run   # see the plan, move nothing
video-mcp sort ~/Footage/shoot-0924             # asks before moving
video-mcp sort --undo ~/Footage/shoot-0924      # put everything back
```

Every clip is analysed on your machine (transcript, keyframes, OCR, and ffmpeg checks for focus,
exposure, shake, audio clipping, silence, black and frozen frames). A signed-in agent CLI
(`--agent grok|codex|claude`; default is the first one installed, in that order) looks at each
clip and says keep or reject, then groups the whole shoot into topics and picks the best of
repeated takes. Files are moved in place and never overwritten; names are kept, except that a
clash gets ` (2)` added:

```
shoot/
  <Topic>/a-roll/ · <Topic>/b-roll/
  _rejects/<Topic>/{a-roll,b-roll}/   bad clips, alternate takes, near-duplicates
  footage-report.md                   every clip with its verdict and reasons
  .footage-sort/                      analysis cache + undo manifest
```

A-roll is a clip with speech over at least 40% of its length; a folder named `a-roll` or
`b-roll` overrides that. Very short, mostly black or frozen clips are rejected without asking
the agent. Re-running only sorts clips added since. Options: `--model`, `--yes`,
`--concurrency N` (default 3), `--no-cache`. `--undo` reverts the most recent run; repeat it to
go further back. Speech-to-text runs locally with whisper.cpp; only if no local backend works and
`OPENAI_API_KEY` is set is audio sent to OpenAI's Whisper API.

## Tools

| Tool | Use when |
|------|----------|
| `video_check_deps` | Setup / missing ffmpeg / Whisper |
| `video_info` | Duration, resolution, codecs (fast) |
| `video_transcribe` | Speech / captions only |
| `video_get_frame` | Exact moment after transcript hit |
| `video_get_frame_burst` | Motion / UI transitions |
| `video_extract_frames` | Keyframes without full pipeline |
| `video_analyze` | “Watch / summarize / understand this video” (frames + speech + OCR) |
| `video_ocr` | On-screen text only (video keyframes or a single image) |
| `video_search_transcript` | Find topic timestamps in long videos |

**Prompt:** `watch_video` — guided workflow for agents.

## Optional dependencies

| Tool | Why |
|------|-----|
| **ffmpeg** | Required — frames, probe, audio |
| **yt-dlp** | YouTube / TikTok / platform URLs (`brew install yt-dlp`) |
| **whisper** / **whisper.cpp** / `OPENAI_API_KEY` | Transcripts when captions are missing |

## Manual config (if you prefer)

```json
{
  "mcpServers": {
    "video": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/videomcp/dist/index.js"]
    }
  }
}
```

Codex / Grok TOML:

```toml
[mcp_servers.video]
command = "node"
args = ["/ABSOLUTE/PATH/TO/videomcp/dist/index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

## Environment

| Variable | Purpose |
|----------|---------|
| `VIDEO_MCP_WORK_DIR` | Cache/download dir |
| `VIDEO_MCP_MAX_INLINE_IMAGES` | Max inline thumbs (default 6) |
| `VIDEO_MCP_WRITE_SIDECARS` | `1` = write `<video>.videomcp.json` next to local files |
| `VIDEO_MCP_DISABLE_OCR` | `1` = skip tesseract |
| `WHISPER_MODEL` / `WHISPER_LANGUAGE` | Local Whisper |
| `OPENAI_API_KEY` | Cloud Whisper fallback |
| `YTDLP_COOKIES` | Auth for restricted URLs |
| `TESSERACT_BIN` | Override tesseract path |

## Dev

```bash
npm install && npm run build
npm start                 # MCP stdio
npm run smoke -- /path/to/video.mp4
```

## License

MIT
