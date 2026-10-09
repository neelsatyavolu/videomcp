import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameResult } from "../../src/types.js";

vi.mock("../../src/media/frames.js", () => ({
  readInlineFrameBase64: vi.fn(),
}));

import { readInlineFrameBase64 } from "../../src/media/frames.js";
import { buildFrameContent } from "../../src/tools/response.js";

const frame: FrameResult = {
  index: 0,
  timeSec: 1.5,
  path: "/tmp/frame.jpg",
  mimeType: "image/jpeg",
  width: 320,
  height: 180,
};

describe("buildFrameContent", () => {
  beforeEach(() => {
    vi.mocked(readInlineFrameBase64).mockReset();
  });

  it("skips a thumb that would exceed the inline base64 budget", async () => {
    vi.mocked(readInlineFrameBase64).mockResolvedValue("a".repeat(200_000));
    const result = await buildFrameContent("hello", [frame], true);
    expect(result.content.some((block) => block.type === "image")).toBe(false);
    expect(result.structuredContent?.inlineCount).toBe(0);
  });

  it("inlines a thumb that fits the budget", async () => {
    vi.mocked(readInlineFrameBase64).mockResolvedValue("a".repeat(1000));
    const result = await buildFrameContent("hello", [frame], true);
    expect(result.content.some((block) => block.type === "image")).toBe(true);
    expect(result.structuredContent?.inlineCount).toBe(1);
  });
});
