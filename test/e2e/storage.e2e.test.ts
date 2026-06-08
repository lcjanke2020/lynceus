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

  it("set_cookies → get_cookies → export captures the cookie (incl. HttpOnly round-trip + redaction)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cdp-cookies-e2e-"));
    try {
      // `hocookie` is HttpOnly and its name does NOT match the sensitive-name
      // heuristic, so its redaction below is attributable to HttpOnly alone.
      // It's the load-bearing claim: an HttpOnly cookie is invisible to
      // document.cookie, so its value reaching the export proves capture went
      // through CDP Network.* — and get_cookies must redact it.
      await call(tools, "set_cookies", {
        cookies: [
          { name: "e2e", value: "yes", url: sampleAppUrl() },
          { name: "hocookie", value: "ho-secret", url: sampleAppUrl(), httpOnly: true },
        ],
      });

      // The HttpOnly cookie is not readable from page JS.
      const dom = await call<{ value: string }>(tools, "evaluate", { expression: "document.cookie" });
      expect(dom.value).not.toContain("hocookie");

      const got = await call<{
        cookies: Array<{ name: string; value?: string; redacted: boolean; value_length: number }>;
      }>(tools, "get_cookies", { urls: [sampleAppUrl()] });

      const cookie = got.cookies.find((c) => c.name === "e2e");
      expect(cookie).toBeTruthy();
      expect(cookie?.redacted).toBe(false);
      expect(cookie?.value).toBe("yes");

      const ho = got.cookies.find((c) => c.name === "hocookie");
      expect(ho?.redacted).toBe(true); // HttpOnly -> redacted on inspection
      expect(ho?.value).toBeUndefined();
      expect(ho?.value_length).toBe("ho-secret".length);

      const f = join(dir, "c.json");
      await call(tools, "export_storage_state", { path: f });
      const state = JSON.parse(await readFile(f, "utf8"));
      expect(state.cookies.some((c: { name: string; value: string }) => c.name === "e2e" && c.value === "yes")).toBe(true);
      // Full HttpOnly value survives into the export (document.cookie can't see it).
      const exportedHo = state.cookies.find((c: { name: string }) => c.name === "hocookie");
      expect(exportedHo?.value).toBe("ho-secret");
      expect(exportedHo?.httpOnly).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
