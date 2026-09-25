import { enrichPath } from "../src/utils/env.js";
enrichPath();

import { analyzeVideo } from "../src/media/analyze.js";
import { ocrImage } from "../src/media/ocr.js";
import { execOk, which } from "../src/utils/exec.js";

const ffmpeg = await which("ffmpeg");
if (!ffmpeg) throw new Error("ffmpeg missing");

const out = "/tmp/videomcp-ocr-test.png";
await execOk(ffmpeg, [
  "-y",
  "-f",
  "lavfi",
  "-i",
  "color=c=white:s=640x200:d=1",
  "-vf",
  "drawtext=text='HELLO ALASKA AIRLINES':fontsize=36:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2",
  "-frames:v",
  "1",
  out,
]);

console.log("synthetic OCR:", JSON.stringify(await ocrImage(out)));

const video = process.argv[2];
if (!video) throw new Error("usage: tsx scripts/check-ocr.mts <video>");
const r = await analyzeVideo(video, { detail: "standard", forceRefresh: true, skipTranscript: true });
console.log("ocrHitCount", r.ocrHitCount);
console.log(r.summary);
