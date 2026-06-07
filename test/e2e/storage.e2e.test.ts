// L3 session portability: export_storage_state / load_storage_state +
// get_cookies / set_cookies against the sample app. The headline case is the
// "drive + resume" round-trip from issue #12: seed localStorage, export to a
// file, clear it, load_storage_state, and confirm the value is restored — all
// through the storage tools. Cookies (incl. the jar) round-trip via CDP, not
// document.cookie, so HttpOnly auth cookies would survive too.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolMap, call, attachToTestChrome, sampleAppUrl } from "./helpers/build-tools.js";

const tools = buildToolMap();

async function setup(): Promise<void> {
  await attachToTestChrome(tools);
  await call(tools, "navigate", { url: sampleAppUrl(), wait: "load" });
}

describe("session portability (e2e)", () => {
  beforeEach(async () => setup());

  it("export → clear → load restores localStorage round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdp-storage-e2e-"));
    try {
      await call(tools, "evaluate", { expression: "localStorage.setItem('k', 'v1')" });

      const f1 = join(dir, "s1.json");
      const e1 = await call<{ origins: number }>(tools, "export_storage_state", { path: f1 });
      expect(e1.origins).toBe(1);
      const s1 = JSON.parse(await readFile(f1, "utf8"));
      expect(s1.origins[0].localStorage).toContainEqual({ name: "k", value: "v1" });

      // Wipe localStorage, then restore from the file.
      await call(tools, "evaluate", { expression: "localStorage.clear()" });
      const loaded = await call<{ origins_restored: string[] }>(tools, "load_storage_state", { path: f1 });
      expect(loaded.origins_restored.length).toBe(1);

      // Re-export and confirm the value is back (round-trips entirely through the tools).
      const f2 = join(dir, "s2.json");
      await call(tools, "export_storage_state", { path: f2 });
      const s2 = JSON.parse(await readFile(f2, "utf8"));
      expect(s2.origins[0].localStorage).toContainEqual({ name: "k", value: "v1" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set_cookies → get_cookies → export captures the cookie", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdp-cookies-e2e-"));
    try {
      await call(tools, "set_cookies", { cookies: [{ name: "e2e", value: "yes", url: sampleAppUrl() }] });

      const got = await call<{ cookies: Array<{ name: string; value?: string; redacted: boolean }> }>(
        tools,
        "get_cookies",
        { urls: [sampleAppUrl()] },
      );
      const cookie = got.cookies.find((c) => c.name === "e2e");
      expect(cookie).toBeTruthy();
      expect(cookie?.redacted).toBe(false);
      expect(cookie?.value).toBe("yes");

      const f = join(dir, "c.json");
      await call(tools, "export_storage_state", { path: f });
      const state = JSON.parse(await readFile(f, "utf8"));
      expect(state.cookies.some((c: { name: string; value: string }) => c.name === "e2e" && c.value === "yes")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
