#!/usr/bin/env node
// cdp-mcp is now lynceus — this shim boots the lynceus server in-process.
// The lynceus entry only starts the server when import.meta.url matches
// process.argv[1] (its run-as-main guard, src/index.ts isRunAsMain), so point
// argv[1] at the realpath-resolved entry and import it via the same URL form
// the guard reconstructs. require()-based resolution can't be used here:
// lynceus's exports map is ESM-only (no "require" condition). Sync
// import.meta.resolve needs Node >= 20.6 — engines pins that floor.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = realpathSync(fileURLToPath(import.meta.resolve("lynceus")));
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
