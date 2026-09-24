import { checkDeps } from "../src/media/deps.js";
import { analyzeVideo } from "../src/media/analyze.js";
import { extractFrameAt } from "../src/media/frames.js";

const sample = process.argv[2] ?? "/tmp/videomcp-sample.mp4";

const deps = await checkDeps();
console.log(
  "DEPS",
  deps.map((d) => `${d.name}:${d.available}`).join(" "),
);

const result = await analyzeVideo(sample, {
  detail: "standard",
  maxFrames: 8,
  forceRefresh: true,
});
console.log(
  JSON.stringify(
    {
      duration: result.info.durationSec,
      resolution: `${result.info.width}x${result.info.height}`,
      frames: result.frames.length,
      transcriptSource: result.transcript?.source ?? null,
      transcriptSegments: result.transcript?.segments.length ?? 0,
      warnings: result.warnings.slice(0, 5),
      elapsedMs: result.elapsedMs,
      firstFrame: result.frames[0]?.path ?? null,
    },
    null,
    2,
  ),
);

const f = await extractFrameAt(sample, 1.0);
console.log("FRAME_AT", f.path);
