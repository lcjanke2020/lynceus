// L2 unit tests for the credential scrubber in spawnMcpServer.
//
// We test the pure `buildSanitizedEnv` helper directly — no real
// subprocess. The transport-level integration is covered by the L3 e2e
// suite (test/e2e/eval-runner-node.e2e.test.ts).
//
// Background: an upstream Codex high-severity review flagged that the
// previous denylist had ANTHROPIC_API_KEY only, so a Node eval trial
// running under, e.g., EVAL_PROVIDER=openai would forward
// OPENAI_API_KEY into the spawned cdp-mcp subprocess; from there a
// `launch_node` debuggee could `evaluate` process.env.OPENAI_API_KEY
// and the value would land in the trace via tool_result. These tests
// pin the expanded scrubber so that regression can't reappear silently.

import { describe, it, expect } from "vitest";
import { buildSanitizedEnv } from "./mcp-client.js";

describe("buildSanitizedEnv — credential denylist", () => {
  it("strips ANTHROPIC_API_KEY (original entry, kept for back-compat)", () => {
    const out = buildSanitizedEnv(
      { ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/usr/bin" },
      undefined,
    );
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("strips all known vendor credentials by explicit name", () => {
    const out = buildSanitizedEnv(
      {
        ANTHROPIC_API_KEY: "a",
        OPENAI_API_KEY: "o",
        EVAL_LM_STUDIO_API_KEY: "l",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
        GEMINI_API_KEY: "g",
        GOOGLE_API_KEY: "k",
        PATH: "/usr/bin",
      },
      undefined,
    );
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.EVAL_LM_STUDIO_API_KEY).toBeUndefined();
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(out.GEMINI_API_KEY).toBeUndefined();
    expect(out.GOOGLE_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("strips future vendor names via the *_API_KEY pattern", () => {
    const out = buildSanitizedEnv(
      { FOO_API_KEY: "leak", NOT_A_KEY: "fine" },
      undefined,
    );
    expect(out.FOO_API_KEY).toBeUndefined();
    expect(out.NOT_A_KEY).toBe("fine");
  });

  it("strips future vendor names via the *_SECRET pattern", () => {
    const out = buildSanitizedEnv(
      { BAR_SECRET: "shh", BAR_SECRETIVE_THING: "fine" },
      undefined,
    );
    expect(out.BAR_SECRET).toBeUndefined();
    // Pattern is anchored with `$` — only EXACT _SECRET suffix matches.
    expect(out.BAR_SECRETIVE_THING).toBe("fine");
  });

  it("strips future vendor names via the *_TOKEN pattern", () => {
    const out = buildSanitizedEnv(
      { BAZ_TOKEN: "bearer", TOKENIZER_PATH: "/x" },
      undefined,
    );
    expect(out.BAZ_TOKEN).toBeUndefined();
    expect(out.TOKENIZER_PATH).toBe("/x");
  });

  it("strips future vendor names via the *_CREDENTIALS pattern", () => {
    const out = buildSanitizedEnv(
      { QUX_CREDENTIALS: "json-blob", PATH: "/usr/bin" },
      undefined,
    );
    expect(out.QUX_CREDENTIALS).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("strips the widened credential-suffix families (AWS / DB / PKI shapes)", () => {
    const out = buildSanitizedEnv(
      {
        AWS_SECRET_ACCESS_KEY: "aws-secret", // *_ACCESS_KEY
        AWS_ACCESS_KEY_ID: "aws-id", // *_ACCESS_KEY_ID
        MY_SECRET_KEY: "sk", // *_SECRET_KEY
        SSH_PRIVATE_KEY: "-----BEGIN", // *_PRIVATE_KEY
        DB_PASSWORD: "hunter2", // *_PASSWORD
        PATH: "/usr/bin",
      },
      undefined,
    );
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(out.MY_SECRET_KEY).toBeUndefined();
    expect(out.SSH_PRIVATE_KEY).toBeUndefined();
    expect(out.DB_PASSWORD).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("does NOT over-match: bare *_KEY / ordinary config stays forwarded", () => {
    // The widened pattern enumerates specific *_KEY families
    // (ACCESS_KEY, ACCESS_KEY_ID, SECRET_KEY, PRIVATE_KEY) rather than a
    // blanket `_KEY$`, so ordinary config that merely ends in _KEY is
    // preserved — otherwise the scrubber would eat legitimate env.
    const out = buildSanitizedEnv(
      { FOO_KEY: "not-secret", CACHE_KEY: "abc", NODE_OPTIONS: "--x", PATH: "/usr/bin" },
      undefined,
    );
    expect(out.FOO_KEY).toBe("not-secret");
    expect(out.CACHE_KEY).toBe("abc");
    expect(out.NODE_OPTIONS).toBe("--x");
    expect(out.PATH).toBe("/usr/bin");
  });

  it("matches pattern case-insensitively", () => {
    const out = buildSanitizedEnv(
      {
        foo_api_key: "leak1",
        Bar_Secret: "leak2",
        BAZ_token: "leak3",
        QUX_credentials: "leak4",
      },
      undefined,
    );
    expect(out.foo_api_key).toBeUndefined();
    expect(out.Bar_Secret).toBeUndefined();
    expect(out.BAZ_token).toBeUndefined();
    expect(out.QUX_credentials).toBeUndefined();
  });

  it("preserves non-credential vars the harness DOES want forwarded", () => {
    const out = buildSanitizedEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/eval",
        CHROME_PATH: "/usr/bin/chromium",
        EVAL_VERTEX_MODEL_ID: "gemini-3.1-pro-preview",
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
      undefined,
    );
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/eval");
    expect(out.CHROME_PATH).toBe("/usr/bin/chromium");
    expect(out.EVAL_VERTEX_MODEL_ID).toBe("gemini-3.1-pro-preview");
    expect(out.NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });

  it("drops undefined process.env values (TS happiness + no literal 'undefined')", () => {
    const env: NodeJS.ProcessEnv = {
      DEFINED: "yes",
      UNDEF: undefined,
    };
    const out = buildSanitizedEnv(env, undefined);
    expect(out.DEFINED).toBe("yes");
    expect("UNDEF" in out).toBe(false);
  });

  it("merges opts.env on top of inherited process_env for non-credential keys", () => {
    const out = buildSanitizedEnv(
      { PATH: "/old", CHROME_PATH: "/old/chrome" },
      { CHROME_PATH: "/new/chrome", EXTRA: "added" },
    );
    expect(out.PATH).toBe("/old"); // inherited untouched
    expect(out.CHROME_PATH).toBe("/new/chrome"); // overridden by opts.env
    expect(out.EXTRA).toBe("added"); // added from opts.env
  });

  it("filters opts.env through the denylist (caller can't bypass)", () => {
    // Even if the harness — or a test — accidentally tries to plumb
    // OPENAI_API_KEY via opts.env, the scrubber must still strip it.
    const out = buildSanitizedEnv(
      { PATH: "/usr/bin" },
      {
        OPENAI_API_KEY: "leak-via-opts",
        FUTURE_VENDOR_API_KEY: "leak-via-opts-pattern",
        CHROME_PATH: "/ok",
      },
    );
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.FUTURE_VENDOR_API_KEY).toBeUndefined();
    expect(out.CHROME_PATH).toBe("/ok");
    expect(out.PATH).toBe("/usr/bin");
  });

  it("returns an empty object when given empty inputs", () => {
    expect(buildSanitizedEnv({}, undefined)).toEqual({});
    expect(buildSanitizedEnv({}, {})).toEqual({});
  });
});
