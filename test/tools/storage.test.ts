import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStorageTools } from "../../src/tools/storage.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerStorageTools);
const exportState = tools.get("export_storage_state")!;
const loadState = tools.get("load_storage_state")!;
const getCookies = tools.get("get_cookies")!;
const setCookies = tools.get("set_cookies")!;

const evalValue = (value: unknown) => () => ({ result: { type: "object", value } });

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cdp-storage-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("export_storage_state", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await exportState.handler({ path: "/tmp/x.json" }))?.error).toBe("no_session");
  });

  it("writes cookies (HttpOnly included) + current-origin localStorage in storageState shape", async () => {
    await withTmp(async (dir) => {
      const { fake } = setupSession();
      fake.respond("Network.getAllCookies", () => ({
        cookies: [
          { name: "sid", value: "abc", domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
          { name: "theme", value: "dark", domain: "example.com", path: "/", expires: 1893456000, httpOnly: false, secure: false },
        ],
      }));
      fake.respond("Runtime.evaluate", evalValue({ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }));
      const path = join(dir, "state.json");
      const r = parseOkEnvelope<any>(await exportState.handler({ path }));
      expect(r).toEqual({ saved: path, cookies: 2, origins: 1 });

      const state = JSON.parse(await readFile(path, "utf8"));
      expect(state.cookies[0]).toEqual({
        name: "sid", value: "abc", domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax",
      });
      // sameSite defaults to Lax when CDP omits it (Playwright requires the field).
      expect(state.cookies[1].sameSite).toBe("Lax");
      expect(state.origins).toEqual([{ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }]);
    });
  });

  it("emits no origins entry for an about:blank page (origin 'null')", async () => {
    await withTmp(async (dir) => {
      const { fake } = setupSession();
      fake.respond("Runtime.evaluate", evalValue({ origin: "null", localStorage: [] }));
      const path = join(dir, "state.json");
      const r = parseOkEnvelope<any>(await exportState.handler({ path }));
      expect(r.origins).toBe(0);
      const state = JSON.parse(await readFile(path, "utf8"));
      expect(state.origins).toEqual([]);
    });
  });
});

describe("load_storage_state", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await loadState.handler({ path: "/tmp/x.json" }))?.error).toBe("no_session");
  });

  it("not_found when the file is missing", async () => {
    setupSession();
    expect(parseErrorEnvelope(await loadState.handler({ path: "/tmp/does-not-exist-xyz.json" }))?.error).toBe("not_found");
  });

  it("invalid_arg for non-JSON content", async () => {
    await withTmp(async (dir) => {
      setupSession();
      const path = join(dir, "bad.json");
      await writeFile(path, "not json at all");
      expect(parseErrorEnvelope(await loadState.handler({ path }))?.error).toBe("invalid_arg");
    });
  });

  it("invalid_arg for valid JSON that isn't a storageState", async () => {
    await withTmp(async (dir) => {
      setupSession();
      const path = join(dir, "wrong.json");
      await writeFile(path, JSON.stringify({ cookies: "nope" }));
      expect(parseErrorEnvelope(await loadState.handler({ path }))?.error).toBe("invalid_arg");
    });
  });

  it("sets cookies (session expiry omitted) and restores matching-origin localStorage", async () => {
    await withTmp(async (dir) => {
      const { fake } = setupSession();
      fake.respond("Runtime.evaluate", evalValue({ restored: ["https://example.com"], skipped: [] }));
      const path = join(dir, "state.json");
      await writeFile(
        path,
        JSON.stringify({
          cookies: [
            { name: "sid", value: "abc", domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
            { name: "theme", value: "dark", domain: "example.com", path: "/", expires: 1893456000 },
          ],
          origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }],
        }),
      );
      fake.clearSentCalls();
      const r = parseOkEnvelope<any>(await loadState.handler({ path }));
      expect(r.cookies).toBe(2);
      expect(r.origins_restored).toEqual(["https://example.com"]);
      expect(r.origins_skipped).toEqual([]);

      const setCall = fake.sentCalls.find((c) => c.method === "Network.setCookies");
      const sent = setCall?.params.cookies as Array<Record<string, unknown>>;
      const sid = sent.find((c) => c.name === "sid")!;
      expect(sid.expires).toBeUndefined(); // -1 session cookie -> omitted
      expect(sid.httpOnly).toBe(true);
      const theme = sent.find((c) => c.name === "theme")!;
      expect(theme.expires).toBe(1893456000);
    });
  });
});

describe("get_cookies", () => {
  it("redacts likely session/auth cookie values for display", async () => {
    const { fake } = setupSession();
    fake.respond("Network.getAllCookies", () => ({
      cookies: [
        { name: "sessionid", value: "topsecret", domain: "x", path: "/", httpOnly: true, secure: true },
        { name: "lang", value: "en", domain: "x", path: "/", httpOnly: false },
      ],
    }));
    const r = parseOkEnvelope<any>(await getCookies.handler({}));
    const sess = r.cookies.find((c: any) => c.name === "sessionid");
    expect(sess.value).toBeUndefined();
    expect(sess.redacted).toBe(true);
    expect(sess.value_length).toBe("topsecret".length);
    const lang = r.cookies.find((c: any) => c.name === "lang");
    expect(lang.value).toBe("en");
    expect(lang.redacted).toBe(false);
  });

  it("uses Network.getCookies when urls are supplied", async () => {
    const { fake } = setupSession();
    fake.respond("Network.getCookies", () => ({ cookies: [{ name: "a", value: "b", domain: "x", path: "/" }] }));
    fake.clearSentCalls();
    await getCookies.handler({ urls: ["https://x"] });
    expect(fake.sentCalls.some((c) => c.method === "Network.getCookies")).toBe(true);
    expect(fake.sentCalls.some((c) => c.method === "Network.getAllCookies")).toBe(false);
  });
});

describe("set_cookies", () => {
  it("missing_arg when the array is empty", async () => {
    setupSession();
    expect(parseErrorEnvelope(await setCookies.handler({ cookies: [] }))?.error).toBe("missing_arg");
  });

  it("missing_arg when a cookie lacks both url and domain", async () => {
    setupSession();
    expect(parseErrorEnvelope(await setCookies.handler({ cookies: [{ name: "a", value: "b" }] }))?.error).toBe("missing_arg");
  });

  it("sets cookies via Network.setCookies and returns the count", async () => {
    const { fake } = setupSession();
    fake.clearSentCalls();
    const r = parseOkEnvelope<any>(await setCookies.handler({ cookies: [{ name: "a", value: "b", domain: "x", path: "/" }] }));
    expect(r.set).toBe(1);
    expect(fake.sentCalls.some((c) => c.method === "Network.setCookies")).toBe(true);
  });

  it("omits the -1 session sentinel before forwarding to CDP (no 1969 expiry)", async () => {
    // Same normalization as load_storage_state: an exported `expires: -1` piped
    // straight into set_cookies must not reach CDP as a past timestamp.
    const { fake } = setupSession();
    fake.clearSentCalls();
    await setCookies.handler({
      cookies: [
        { name: "sid", value: "x", url: "https://x", expires: -1 },
        { name: "keep", value: "y", url: "https://x", expires: 1893456000 },
      ],
    });
    const setCall = fake.sentCalls.find((c) => c.method === "Network.setCookies");
    const sent = setCall?.params.cookies as Array<Record<string, unknown>>;
    expect(sent.find((c) => c.name === "sid")!.expires).toBeUndefined(); // -1 session cookie -> omitted
    expect(sent.find((c) => c.name === "keep")!.expires).toBe(1893456000);
  });
});
