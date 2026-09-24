import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { analyzeVideo } from "./media/analyze.js";
import { checkDeps } from "./media/deps.js";
import {
  extractFrameAt,
  extractFrameBurst,
  extractFrames,
} from "./media/frames.js";
import { ocrFrames, ocrImage } from "./media/ocr.js";
import { probeVideo } from "./media/probe.js";
import { resolveSource } from "./media/resolve.js";
import { transcribeVideo } from "./media/transcribe.js";
import {
  analyzeMarkdown,
  framesMarkdown,
  infoMarkdown,
  toJson,
  transcriptMarkdown,
} from "./utils/format.js";
import {
  buildFrameContent,
  errorResult,
  textResult,
} from "./tools/response.js";

const SourceSchema = z
  .string()
  .min(1)
  .describe(
    "Absolute local path, file:// URI, direct media URL, or platform URL (YouTube/TikTok/etc via yt-dlp)",
  );

const FormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Response text format");

const DetailSchema = z
  .enum(["brief", "standard", "detailed"])
  .default("standard")
  .describe(
    "brief=metadata+transcript only; standard=scene frames+transcript; detailed=dense frames",
  );

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "video_check_deps",
    {
      title: "Check video dependencies",
      description: `Verify ffmpeg, ffprobe, yt-dlp, and Whisper backends are available. Call first when setup fails.

Returns dependency name, availability, path, version, and install hints.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const deps = await checkDeps();
        const lines = ["# Video MCP dependencies", ""];
        for (const d of deps) {
          lines.push(
            `- **${d.name}**: ${d.available ? "OK" : "MISSING"}${d.path ? ` (\`${d.path}\`)` : ""}${d.version ? ` — ${d.version}` : ""}`,
          );
          if (d.note) lines.push(`  - ${d.note}`);
        }
        return textResult(lines.join("\n"), { deps });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "video_info",
    {
      title: "Video metadata",
      description: `Fast metadata probe (duration, resolution, codecs, audio presence) without transcription or frames.

Use before expensive analysis to plan detail level / time ranges.`,
      inputSchema: {
        source: SourceSchema,
        response_format: FormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ source, response_format }) => {
      try {
        const resolved = await resolveSource(source);
        const info = await probeVideo(
          resolved.path,
          resolved.source,
          resolved.sourceKind,
        );
        const payload = {
          ...info,
          title: resolved.title,
          warnings: resolved.warnings,
        };
        const text =
          response_format === "json"
            ? toJson(payload)
            : infoMarkdown(info) +
              (resolved.title ? `\n- **Title**: ${resolved.title}` : "") +
              (resolved.warnings.length
                ? `\n\n## Warnings\n${resolved.warnings.map((w) => `- ${w}`).join("\n")}`
                : "");
        return textResult(text, payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "video_transcribe",
    {
      title: "Transcribe video audio",
      description: `Timestamped transcript from captions (preferred) or local/cloud Whisper.

Order: sidecar .vtt/.srt → yt-dlp captions → whisper.cpp → whisper CLI → OpenAI Whisper API.
Fast for YouTube (native captions). Local files need Whisper or a sidecar caption file.`,
      inputSchema: {
        source: SourceSchema,
        language: z
          .string()
          .optional()
          .describe("Language code hint for Whisper (e.g. en, es, pt)"),
        force_whisper: z
          .boolean()
          .default(false)
          .describe("Skip captions and force ASR"),
        response_format: FormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ source, language, force_whisper, response_format }) => {
      try {
        const resolved = await resolveSource(source);
        const { transcript, warnings } = await transcribeVideo(resolved.path, {
          language,
          forceWhisper: force_whisper,
          captionsPath: resolved.captionsPath,
        });
        if (!transcript) {
          return textResult(
            `No transcript.\n\nWarnings:\n${[...resolved.warnings, ...warnings].map((w) => `- ${w}`).join("\n")}`,
            { warnings: [...resolved.warnings, ...warnings] },
          );
        }
        const payload = { transcript, warnings: [...resolved.warnings, ...warnings] };
        const text =
          response_format === "json"
            ? toJson(payload)
            : transcriptMarkdown(transcript) +
              (warnings.length
                ? `\n\n## Warnings\n${warnings.map((w) => `- ${w}`).join("\n")}`
                : "");
        return textResult(text, payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "video_get_frame",
    {
      title: "Get frame at timestamp",
      description: `Extract a single JPEG frame at a timestamp (seconds). Returns file path and an inline image for vision-capable clients.

Use after reading a transcript to inspect a specific moment.`,
      inputSchema: {
        source: SourceSchema,
        time_sec: z.number().min(0).describe("Timestamp in seconds"),
        inline_image: z
          .boolean()
          .default(true)
          .describe("Include base64 image content block"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ source, time_sec, inline_image }) => {
      try {
        const resolved = await resolveSource(source);
        const frame = await extractFrameAt(resolved.path, time_sec);
        const text = `Frame @ ${time_sec}s\n\nPath: \`${frame.path}\``;
        return buildFrameContent(text, [frame], inline_image);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "video_get_frame_burst",
    {
      title: "Burst frames in time range",
      description: `Extract N frames across a short time window for motion, UI transitions, or animations.

Prefer narrow windows (e.g. 0.5–3s) with 4–16 frames.`,
      inputSchema: {
        source: SourceSchema,
        start_sec: z.number().min(0),
        end_sec: z.number().min(0),
        count: z.number().int().min(2).max(30).default(8),
        inline_images: z.boolean().default(true),
        response_format: FormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ source, start_sec, end_sec, count, inline_images, response_format }) => {
      try {
        if (end_sec <= start_sec) {
          return errorResult("end_sec must be greater than start_sec");
        }
        const resolved = await resolveSource(source);
        const frames = await extractFrameBurst(
          resolved.path,
          start_sec,
          end_sec,
          count,
        );
        const text =
          response_format === "json"
            ? toJson({ frames })
            : framesMarkdown(frames);
        return buildFrameContent(text, frames, inline_images);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "video_extract_frames",
    {
      title: "Extract key frames",
      description: `Extract representative JPEG frames via scene-change detection and/or interval sampling.

Modes: scene (visual cuts), interval (uniform), both (default fallback). Returns paths always; inline images for vision clients (capped).`,
      inputSchema: {
        source: SourceSchema,
        detail: DetailSchema,
        max_frames: z.number().int().min(1).max(60).optional(),
        mode: z.enum(["scene", "interval", "both"]).default("both"),
        start_sec: z.number().min(0).optional(),
        end_sec: z.number().min(0).optional(),
        inline_images: z.boolean().default(true),
        response_format: FormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const resolved = await resolveSource(params.source);
        const info = await probeVideo(
          resolved.path,
          resolved.source,
          resolved.sourceKind,
        );
        const frames = await extractFrames(resolved.path, {
          durationSec: info.durationSec,
          detail: params.detail,
          maxFrames: params.max_frames,
          mode: params.mode,
          startSec: params.start_sec,
          endSec: params.end_sec,
        });
        const text =
          params.response_format === "json"
            ? toJson({ info, frames })
            : `${infoMarkdown(info)}\n\n${framesMarkdown(frames)}`;
        return buildFrameContent(text, frames, params.inline_images, {
          info,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "video_analyze",
    {
      title: "Full video analysis",
      description: `Most powerful one-shot tool: resolve source → probe → transcript + keyframes (parallel) → OCR on-screen text → merged timeline + agent summary.

Prefer this when the user asks to "watch", "summarize", or "understand" a video.
Use detail=brief for long lectures when only speech matters; detailed for short UI demos.

Returns: at-a-glance summary, metadata, transcript, OCR text, frame paths (+ evenly spaced inline thumbs), timeline, warnings.`,
      inputSchema: {
        source: SourceSchema,
        detail: DetailSchema,
        max_frames: z.number().int().min(0).max(60).optional(),
        language: z.string().optional(),
        start_sec: z.number().min(0).optional(),
        end_sec: z.number().min(0).optional(),
        skip_frames: z.boolean().default(false),
        skip_transcript: z.boolean().default(false),
        skip_ocr: z
          .boolean()
          .default(false)
          .describe("Skip tesseract OCR on keyframes"),
        force_refresh: z.boolean().default(false),
        mode: z.enum(["scene", "interval", "both"]).optional(),
        inline_images: z.boolean().default(true),
        response_format: FormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const result = await analyzeVideo(params.source, {
          detail: params.detail,
          maxFrames: params.max_frames,
          language: params.language,
          startSec: params.start_sec,
          endSec: params.end_sec,
          skipFrames: params.skip_frames,
          skipTranscript: params.skip_transcript,
          skipOcr: params.skip_ocr,
          forceRefresh: params.force_refresh,
          mode: params.mode,
        });

        const text =
          params.response_format === "json"
            ? toJson(result)
            : analyzeMarkdown(result);

        const structured = {
          summary: result.summary,
          info: result.info,
          ocrHitCount: result.ocrHitCount,
          ocr: result.frames
            .filter((f) => f.ocrText?.trim())
            .map((f) => ({ timeSec: f.timeSec, text: f.ocrText })),
          transcript: result.transcript
            ? {
                source: result.transcript.source,
                language: result.transcript.language,
                segmentCount: result.transcript.segments.length,
                fullText: result.transcript.fullText.slice(0, 8_000),
                segments: result.transcript.segments.slice(0, 200),
              }
            : null,
          warnings: result.warnings,
          detail: result.detail,
          elapsedMs: result.elapsedMs,
          timeline: result.timeline.slice(0, 100),
          sidecarPath: result.sidecarPath ?? null,
        };

        return buildFrameContent(
          text,
          result.frames,
          params.inline_images,
          structured,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "video_ocr",
    {
      title: "OCR frames or a single image",
      description: `Extract on-screen text with tesseract.
Pass a video source to sample keyframes + OCR, or an image path for a single frame/screenshot.
Requires tesseract on PATH (brew install tesseract).`,
      inputSchema: {
        source: SourceSchema.describe(
          "Video path/URL, or absolute path to a .jpg/.png image",
        ),
        max_frames: z.number().int().min(1).max(30).default(10),
        response_format: FormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ source, max_frames, response_format }) => {
      try {
        const lower = source.toLowerCase();
        if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(lower)) {
          const { resolveLocalPath } = await import("./utils/paths.js");
          const img = await resolveLocalPath(source);
          const text = await ocrImage(img);
          const payload = { path: img, text };
          return textResult(
            response_format === "json"
              ? toJson(payload)
              : `# OCR\n\n\`${img}\`\n\n\`\`\`\n${text || "(no text)"}\n\`\`\``,
            payload,
          );
        }
        const resolved = await resolveSource(source);
        const info = await probeVideo(
          resolved.path,
          resolved.source,
          resolved.sourceKind,
        );
        const frames = await extractFrames(resolved.path, {
          durationSec: info.durationSec,
          detail: "standard",
          maxFrames: max_frames,
        });
        const { ocrCount, warnings } = await ocrFrames(frames, max_frames, 3);
        const hits = frames
          .filter((f) => f.ocrText?.trim())
          .map((f) => ({ timeSec: f.timeSec, path: f.path, text: f.ocrText }));
        const payload = { ocrCount, hits, warnings, info };
        if (response_format === "json") {
          return textResult(toJson(payload), payload);
        }
        const lines = [`# OCR results (${ocrCount} frames with text)`, ``];
        for (const h of hits) {
          lines.push(`## @ ${h.timeSec.toFixed(2)}s`);
          lines.push("```", h.text ?? "", "```", ``);
        }
        if (warnings.length) {
          lines.push(`# Warnings`, ...warnings.map((w) => `- ${w}`));
        }
        return textResult(lines.join("\n"), payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "video_search_transcript",
    {
      title: "Search within transcript",
      description: `Transcribe (or reuse captions) then return segments matching a query string (case-insensitive).

Useful for long videos: find when a topic is mentioned, then video_get_frame at that timestamp.`,
      inputSchema: {
        source: SourceSchema,
        query: z.string().min(1).describe("Substring or keywords to find"),
        language: z.string().optional(),
        response_format: FormatSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ source, query, language, response_format }) => {
      try {
        const resolved = await resolveSource(source);
        const { transcript, warnings } = await transcribeVideo(resolved.path, {
          language,
          captionsPath: resolved.captionsPath,
        });
        if (!transcript) {
          return textResult(`No transcript to search.\n${warnings.join("\n")}`, {
            warnings,
          });
        }
        const q = query.toLowerCase();
        const hits = transcript.segments.filter((s) =>
          s.text.toLowerCase().includes(q),
        );
        const payload = {
          query,
          matchCount: hits.length,
          matches: hits,
          warnings,
        };
        if (response_format === "json") {
          return textResult(toJson(payload), payload);
        }
        const lines = [
          `# Transcript search: "${query}"`,
          ``,
          `Matches: ${hits.length}`,
          ``,
        ];
        for (const h of hits.slice(0, 50)) {
          lines.push(`- [${h.start.toFixed(1)}s–${h.end.toFixed(1)}s] ${h.text}`);
        }
        if (hits.length > 50) lines.push(`- … ${hits.length - 50} more`);
        return textResult(lines.join("\n"), payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Help agents pick the right workflow
  server.registerPrompt(
    "watch_video",
    {
      title: "Watch / understand a video",
      description:
        "Guide for analyzing a local file or URL with video-mcp tools",
      argsSchema: {
        source: z.string().describe("Absolute path or URL to the video"),
        question: z
          .string()
          .optional()
          .describe("What to look for (optional)"),
      },
    },
    ({ source, question }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Analyze this video with the video MCP tools.

Source: ${source}
${question ? `Question: ${question}` : "Question: What happens in this video? Summarize visuals, speech, and on-screen text."}

Workflow:
1. Call video_analyze with detail=standard (or brief if >30min speech-only).
2. Read the "At a glance" summary, transcript, and OCR sections.
3. If you need a specific moment, call video_get_frame or video_get_frame_burst at that timestamp.
4. Answer using timestamps. Prefer frame paths / OCR / quotes over guessing.`,
          },
        },
      ],
    }),
  );

  return server;
}
