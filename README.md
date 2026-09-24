# video-mcp-server

**Local-first video understanding MCP** for Claude Desktop, Claude Code, Codex, Grok, and any MCP client.

Turns video into what agents already understand: **metadata + timestamped transcript + key frames + timeline**.

## Quick install (one command)

**Prerequisites:** Node.js 18+ and [ffmpeg](https://ffmpeg.org/) (`brew install ffmpeg`).

### From this repo (local)

```bash
cd videomcp
npm install && npm run build
node dist/index.js setup      # ffmpeg + tesseract + whisper-cpp + model
node dist/index.js install    # Claude Desktop / Code / Codex / Grok
```

### Global (after publish / from path)

```bash
npm install -g .
# or: npm install -g video-mcp-server

video-mcp install          # all clients
video-mcp doctor           # check ffmpeg / Whisper / installs
```

### npx (no global install)

```bash
npx video-mcp-server install
```

`install` wires **Claude Desktop**, **Claude Code**, **Codex**, and **Grok** automatically. Restart the app / start a new agent session after installing.

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
