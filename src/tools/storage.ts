import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { requireSession } from "../session/state.js";
import { ToolError } from "../util/errors.js";
import { registerJsonTool } from "./_register.js";

/**
 * Session-portability tools (issue #12 items 4, 5).
 *
 * Cookies go through CDP `Network.*` (NOT `document.cookie`) so HttpOnly
 * auth/session cookies — the whole reason to resume a session — round-trip.
 * localStorage is read/written via `Runtime.evaluate` (the `Storage.*` domain
 * is out of scope per AGENTS.md). The on-disk shape is the de-facto Playwright
 * `storageState` JSON so a flow can be handed to/from mainstream tooling.
 *
 * v1 localStorage scope is the **current page origin** only: localStorage is
 * origin-partitioned and CDP can only read/write it for a document that is
 * actually on that origin. Cookies (the load-bearing part for auth resume) are
 * captured/restored for all origins. Multi-origin localStorage restore would
 * require navigating to each origin first; origins in the file that don't match
 * the current page are reported in `origins_skipped` rather than silently lost.
 *
 * File read/write mirrors `screenshot path=`: no extra path filter — the
 * operator gate is the same `--allow-remote`/non-loopback rule (README §SSE).
 */

const SENSITIVE_NAME = /(sess|sid|token|auth|csrf|xsrf|jwt|secret|api[-_]?key)/i;

const sameSiteSchema = z.enum(["Strict", "Lax", "None"]);

const storageStateSchema = z.object({
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string(),
        expires: z.number().optional(),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: sameSiteSchema.optional(),
      }),
    )
    .default([]),
  origins: z
    .array(
      z.object({
        origin: z.string(),
        localStorage: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
      }),
    )
    .default([]),
});

type StorageState = z.infer<typeof storageStateSchema>;
type StateCookie = StorageState["cookies"][number];

const cookieParamSchema = z.object({
  name: z.string(),
  value: z.string(),
  url: z.string().optional().describe("Cookie URL (provide this OR domain)."),
  domain: z.string().optional(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: sameSiteSchema.optional(),
  expires: z.number().optional().describe("Expiry as seconds since epoch; omit for a session cookie."),
});

/**
 * Write `data` to `dest` at mode 0o600, overwrite-safe and TOCTOU-safe.
 *
 * The storage-state file holds plaintext cookie secrets, so the 0o600
 * postcondition must hold even on a shared, world-writable directory. Two traps:
 *  - Node's writeFile `mode` only applies when it *creates* the file, so writing
 *    straight to `dest` would leave an existing 0644 file world-readable.
 *  - A *predictable* temp path lets an attacker pre-create (or symlink) it at
 *    0644, so the secret gets written through their file and renamed into place.
 *
 * So: create a temp with an **unpredictable** same-directory suffix using
 * exclusive create (`flag: "wx"` ⇒ O_CREAT|O_EXCL — fails on any pre-existing
 * file and refuses to follow a symlink), which makes 0o600 a real creation-time
 * guarantee, then atomically rename it over the destination (same filesystem, so
 * the secret never exists at the destination path in a half-written/0644 state).
 * Retry on the astronomically-unlikely name collision.
 */
async function writeSecretFileAtomic(dest: string, data: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, data, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        lastErr = e;
        continue; // collision (or planted file/symlink) — try a fresh random name
      }
      throw e; // ENOENT (missing parent dir), EACCES, etc.
    }
    try {
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    return;
  }
  throw lastErr;
}

export function registerStorageTools(server: McpServer) {
  registerJsonTool(
    server,
    "export_storage_state",
    "Save the browser session (all cookies including HttpOnly, plus the current page origin's localStorage) to a JSON file in the de-facto Playwright storageState shape, so a flow can be resumed in a fresh session or handed to other tooling. The file preserves full cookie values (it exists to resume auth) — treat it as a secret. File write is gated by the same operator rule as screenshot path= / --allow-remote.",
    { path: z.string().describe("Absolute path to write the storageState JSON to.") },
    async (input: { path: string }) => {
      const s = requireSession();
      const { cookies } = (await s.client!.send("Network.getAllCookies")) as { cookies: CdpCookie[] };
      const probe = await s.client!.send("Runtime.evaluate", {
        expression: READ_ORIGIN_AND_LOCALSTORAGE,
        returnByValue: true,
      });
      const probed = (probe.result?.value ?? { origin: "null", localStorage: [] }) as {
        origin: string;
        localStorage: Array<{ name: string; value: string }>;
      };
      const origins =
        probed.origin && probed.origin !== "null"
          ? [{ origin: probed.origin, localStorage: probed.localStorage }]
          : [];
      const state: StorageState = { cookies: cookies.map(cdpCookieToState), origins };
      // The file holds full cookie values (incl. HttpOnly auth/session tokens) —
      // the description says "treat it as a secret". writeSecretFileAtomic writes
      // it 0o600 and overwrite-safe (see the helper for the threat model).
      try {
        await writeSecretFileAtomic(input.path, JSON.stringify(state, null, 2));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolError(
            "not_found",
            `could not write storage-state file (does the parent directory exist?): ${(e as Error).message}`,
          );
        }
        throw e; // EACCES/EISDIR/etc. surface as internal_error via registerJsonTool
      }
      return { saved: input.path, cookies: state.cookies.length, origins: origins.length };
    },
  );

  registerJsonTool(
    server,
    "load_storage_state",
    "Restore a session from a Playwright-shaped storageState JSON file: sets all cookies (no navigation needed), then restores localStorage for the entries whose origin matches the current page. Cookies are added on top of the existing jar (additive, not a clean-context replace), so prefer a fresh session for Playwright-equivalent semantics. Origins that don't match the current page are returned in origins_skipped (restoring them would require navigating there first). File read is gated by the same operator rule as screenshot path= / --allow-remote.",
    { path: z.string().describe("Absolute path to a storageState JSON file (as written by export_storage_state).") },
    async (input: { path: string }) => {
      const s = requireSession();
      let raw: string;
      try {
        raw = await readFile(input.path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolError("not_found", `could not read storage-state file: ${(e as Error).message}`);
        }
        throw e; // EACCES/EISDIR/etc. surface as internal_error rather than masquerading as not_found
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ToolError("invalid_arg", "storage-state file is not valid JSON");
      }
      const result = storageStateSchema.safeParse(parsed);
      if (!result.success) {
        throw new ToolError("invalid_arg", `storage-state file is not a valid storageState: ${result.error.message}`);
      }
      const state = result.data;
      if (state.cookies.length > 0) {
        await s.client!.send("Network.setCookies", { cookies: state.cookies.map(stateCookieToCdp) });
      }
      const restore = await s.client!.send("Runtime.evaluate", {
        expression: restoreLocalStorageExpr(state.origins),
        returnByValue: true,
      });
      const restored = (restore.result?.value ?? { restored: [], skipped: state.origins.map((o) => o.origin) }) as {
        restored: string[];
        skipped: string[];
      };
      return {
        loaded: input.path,
        cookies: state.cookies.length,
        origins_restored: restored.restored,
        origins_skipped: restored.skipped,
      };
    },
  );

  registerJsonTool(
    server,
    "get_cookies",
    "List cookies (via CDP, so HttpOnly cookies are included) with their flags. For safe printing, the VALUE of likely session/auth cookies is redacted (httpOnly cookies, or names matching sess/sid/token/auth/csrf/jwt/secret/api-key); only value_length is shown for those. Full values are obtainable only through export_storage_state.",
    {
      urls: z
        .array(z.string())
        .optional()
        .describe("Restrict to cookies visible to these URLs; omit for all cookies in the browser."),
    },
    async (input: { urls?: string[] }) => {
      const s = requireSession();
      const res = (
        input.urls && input.urls.length > 0
          ? await s.client!.send("Network.getCookies", { urls: input.urls })
          : await s.client!.send("Network.getAllCookies")
      ) as { cookies: CdpCookie[] };
      return { cookies: res.cookies.map(redactForDisplay) };
    },
  );

  registerJsonTool(
    server,
    "set_cookies",
    "Set one or more cookies in the browser cookie jar via CDP. Each cookie needs a url OR a domain. For restoring a saved session, prefer load_storage_state; this is the lower-level primitive.",
    { cookies: z.array(cookieParamSchema).describe("Cookies to set.") },
    async (input: { cookies: Array<z.infer<typeof cookieParamSchema>> }) => {
      const s = requireSession();
      if (input.cookies.length === 0) throw new ToolError("missing_arg", "cookies array is empty");
      const missing = input.cookies.find((c) => !c.url && !c.domain);
      if (missing) throw new ToolError("missing_arg", `cookie '${missing.name}' needs a url or domain`);
      // Normalize the session-cookie sentinel the same way load_storage_state
      // does, so an exported `expires: -1` piped in here isn't sent as a 1969 expiry.
      await s.client!.send("Network.setCookies", {
        cookies: input.cookies.map(withSessionExpiryOmitted),
      });
      return { set: input.cookies.length };
    },
  );
}

// ---------------------------------------------------------------------------
// CDP <-> Playwright storageState cookie mapping

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

function cdpCookieToState(c: CdpCookie): StateCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    // CDP uses -1 (or a missing field) for session cookies; Playwright too.
    expires: typeof c.expires === "number" ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    // Playwright requires sameSite; CDP may omit it. Lax is the browser default.
    sameSite: c.sameSite ?? "Lax",
  };
}

// Structural subset of CDP's Network.CookieParam — kept local to avoid coupling
// to either `devtools-protocol` copy on disk (the root one and the older one
// bundled under @types/chrome-remote-interface disagree on partitionKey's type).
interface CdpCookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

/**
 * CDP's `Network.setCookies` reads `expires` as an absolute epoch-seconds
 * timestamp, so the session-cookie sentinel (`-1`, which `export_storage_state`
 * writes) must be dropped rather than forwarded — otherwise the cookie is set
 * already-expired (1969) and silently rejected. Shared by `load_storage_state`
 * and `set_cookies` so both restore paths normalize identically.
 */
function withSessionExpiryOmitted<T extends { expires?: number }>(cookie: T): T {
  if (typeof cookie.expires === "number" && cookie.expires >= 0) return cookie;
  const copy: T = { ...cookie };
  delete copy.expires;
  return copy;
}

function stateCookieToCdp(c: StateCookie): CdpCookieParam {
  const param: CdpCookieParam = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    expires: c.expires,
  };
  if (c.sameSite) param.sameSite = c.sameSite;
  // -1 / undefined means a session cookie — omit expires entirely.
  return withSessionExpiryOmitted(param);
}

function redactForDisplay(c: CdpCookie): Record<string, unknown> {
  const redacted = !!c.httpOnly || SENSITIVE_NAME.test(c.name);
  const out: Record<string, unknown> = {
    name: c.name,
    domain: c.domain,
    path: c.path,
    expires: typeof c.expires === "number" ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite ?? null,
    redacted,
    value_length: (c.value ?? "").length,
  };
  if (!redacted) out.value = c.value;
  return out;
}

// ---------------------------------------------------------------------------
// In-page expressions

/** Read the current origin and its localStorage as { origin, localStorage:[{name,value}] }. */
const READ_ORIGIN_AND_LOCALSTORAGE = String.raw`(() => {
  const items = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === null) continue;
      const v = localStorage.getItem(k);
      if (v === null) continue;
      items.push({ name: k, value: v });
    }
  } catch (e) {}
  return { origin: location.origin, localStorage: items };
})()`;

/**
 * For each origin in the file whose origin matches the current page, write its
 * localStorage entries; report which origins were restored vs skipped.
 */
function restoreLocalStorageExpr(origins: StorageState["origins"]): string {
  return String.raw`(() => {
    const origins = ${JSON.stringify(origins)};
    const current = location.origin;
    const restored = [];
    const skipped = [];
    for (const o of origins) {
      if (o.origin !== current) {
        skipped.push(o.origin);
        continue;
      }
      // If any setItem throws (quota exceeded, storage disabled), report the
      // origin as skipped rather than misleadingly claiming it was restored.
      let ok = true;
      for (const it of o.localStorage) {
        try { localStorage.setItem(it.name, it.value); } catch (e) { ok = false; }
      }
      (ok ? restored : skipped).push(o.origin);
    }
    return { restored, skipped };
  })()`;
}
