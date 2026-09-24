# video-mcp-server

Local-first MCP: video → metadata + transcript + frames + timeline for agent clients.

## Dev

```bash
npm install && npm run build
npm start                    # stdio MCP
node dist/index.js install   # wire Claude Desktop / Code / Codex / Grok
node dist/index.js doctor
npm run smoke -- /path/to/video.mp4
```

## CLI

`video-mcp` / `video-mcp-server` (same binary):

- no args → MCP stdio
- `install | uninstall | status | doctor | help`

## Tools

`video_check_deps` · `video_info` · `video_transcribe` · `video_get_frame` · `video_get_frame_burst` · `video_extract_frames` · `video_analyze` · `video_search_transcript`

## Stack

TypeScript MCP SDK · ffmpeg/ffprobe · yt-dlp (optional) · Whisper backends (optional)

## Notes

- Local paths must be **absolute**
- Prefer `video_analyze` for full understanding; use cheaper tools when possible
- Inline images capped by `VIDEO_MCP_MAX_INLINE_IMAGES` (paths always returned)
