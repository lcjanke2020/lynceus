// L3 screenshot: verify the bytes returned by screenshot() are real image
// bytes (PNG magic or JPEG magic), not an empty/corrupted buffer. The
// captureBeyondViewport / quality flag respect is documented in the
// pre-flagged Chromium gaps; this spec asserts byte-shape only.

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildToolMap,
  call,
  attachToTestChrome,
  sampleAppUrl,
} from "./helpers/build-tools.js";

const tools = buildToolMap();

async function setup(): Promise<void> {
  await attachToTestChrome(tools);
  await call(tools, "navigate", { url: sampleAppUrl(), wait: "load" });
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe("screenshot (e2e)", () => {
  beforeEach(async () => setup());

  it("default (PNG) screenshot returns bytes starting with PNG magic", async () => {
    const r = await call<{ format: string; base64: string }>(tools, "screenshot");
    expect(r.format).toBe("png");
    const buf = Buffer.from(r.base64, "base64");
    expect(buf.length).toBeGreaterThan(PNG_MAGIC.length);
    expect(buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
  });

  it("JPEG screenshot with quality 80 returns JPEG magic", async () => {
    const r = await call<{ format: string; base64: string }>(tools, "screenshot", {
      format: "jpeg",
      quality: 80,
    });
    expect(r.format).toBe("jpeg");
    const buf = Buffer.from(r.base64, "base64");
    expect(buf.length).toBeGreaterThan(JPEG_MAGIC.length);
    expect(buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)).toBe(true);
  });
});
