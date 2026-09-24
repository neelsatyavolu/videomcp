import { analyzeVideo } from "../src/media/analyze.js";
import { readFrameBase64, readInlineFrameBase64 } from "../src/media/frames.js";

const source =
  process.argv[2] ??
  "/Users/neel/Downloads/InFocus/BTS Airport/B-roll/20260114_A741386.MP4";

const r = await analyzeVideo(source, {
  detail: "standard",
  forceRefresh: true,
  skipTranscript: true,
});

console.log(
  JSON.stringify(
    {
      frames: r.frames.map((f) => ({
        i: f.index,
        t: f.timeSec,
        file: f.path.split("/").slice(-1)[0],
      })),
      elapsedMs: r.elapsedMs,
    },
    null,
    2,
  ),
);

if (r.frames[0]) {
  const full = await readFrameBase64(r.frames[0].path);
  const inline = await readInlineFrameBase64(r.frames[0].path);
  console.log({
    full_b64: full.length,
    inline_b64: inline.length,
    full_kb: Math.round((full.length * 0.75) / 1024),
    inline_kb: Math.round((inline.length * 0.75) / 1024),
  });
  let total = 0;
  for (const f of r.frames.slice(0, 6)) {
    total += (await readInlineFrameBase64(f.path)).length;
  }
  console.log({
    six_inline_total_b64: total,
    six_est_kb: Math.round((total * 0.75) / 1024),
  });
}
