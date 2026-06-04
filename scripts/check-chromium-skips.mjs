#!/usr/bin/env node
// Enforcement for the @chromium-skip policy documented in
// docs/known-chromium-gaps.md.
//
// Invariants (both must hold; either failure exits non-zero):
//   1. Every test/e2e/**/*.test.ts that contains `@chromium-skip` or
//      `it.skipIf(...chromium...)` or `describe.skipIf(...chromium...)`
//      must have a corresponding row in docs/known-chromium-gaps.md.
//   2. Every row in docs/known-chromium-gaps.md must reference a spec
//      that still exists. (Catches stale rows after a spec was renamed
//      or deleted.)
//
// Wired into `pretest:e2e` (so every PR run gates) and also exposed as
// `npm run lint:chromium-skips` for ad-hoc invocation.
//
// Zero-skip state is fine — the script is a no-op then. This is the
// expected initial state when L3 first lands.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const E2E_DIR = join(ROOT, "test", "e2e");
const GAPS_FILE = join(ROOT, "docs", "known-chromium-gaps.md");

const SKIP_TAG_RE = /@chromium-skip\s+—?\s*([A-Za-z0-9._\-]+)/g;
// Line-based: a line that mentions both `.skipIf(` and `chromium` somewhere
// after it. The earlier `\([^)]*chromium` regex terminated at the first `)`
// and missed guards like `it.skipIf(getBrowser() === "chromium", ...)`
// (Opus PR #11 review M2).
const SKIPIF_LINE_RE = /(?:it|describe|test)\.skipIf\s*\(.*chromium/;

function listSpecs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...listSpecs(full));
    } else if (full.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function gatherSkipsInSpec(file) {
  const text = readFileSync(file, "utf8");
  const tags = [];
  for (const m of text.matchAll(SKIP_TAG_RE)) {
    if (m[1]) tags.push(m[1]);
  }
  // Scan line-by-line so a `.skipIf(...)` with nested parens still matches.
  let hasSkipIf = false;
  for (const line of text.split(/\r?\n/)) {
    if (SKIPIF_LINE_RE.test(line)) {
      hasSkipIf = true;
      break;
    }
  }
  return { file, tags, hasSkipIf };
}

function parseGapsTable(text) {
  // Parse markdown table rows whose first cell looks like a spec name.
  // We just extract the first column and look for `.test.ts`.
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // markdown table: '', col1, col2, ..., ''
    const first = cells[1] ?? "";
    if (!first || first.startsWith("---")) continue;
    if (first.startsWith("Spec")) continue; // header
    if (first.startsWith("_none yet")) continue; // pre-seed footer
    if (first.includes(".test.ts") || first.startsWith("`") || /^[A-Za-z0-9._\-]+$/.test(first)) {
      rows.push({ spec: first, tag: (cells[2] ?? "").trim() });
    }
  }
  return rows;
}

const specs = listSpecs(E2E_DIR);
let gapsText = "";
try {
  gapsText = readFileSync(GAPS_FILE, "utf8");
} catch {
  console.error(`check-chromium-skips: ${GAPS_FILE} is missing. Create it (it can be empty besides the header).`);
  process.exit(1);
}
const tableRows = parseGapsTable(gapsText);

const errors = [];

// Invariant 1: every skip in code must have a row. Match by exact tag-cell
// only — earlier permissive `r.spec.includes(specFilename)` made any row
// mentioning a spec retroactively "cover" every tag in that spec, including
// typo'd ones (Opus PR #11 review M3).
for (const spec of specs) {
  const info = gatherSkipsInSpec(spec);
  const rel = relative(ROOT, spec).split(sep).join("/");
  for (const tag of info.tags) {
    const found = tableRows.some(
      (r) => r.tag === tag || r.tag === `\`${tag}\``,
    );
    if (!found) {
      errors.push(
        `MISSING_TABLE_ROW: ${rel} has @chromium-skip tag '${tag}' but docs/known-chromium-gaps.md has no matching tag-cell row.`,
      );
    }
  }
  if (info.hasSkipIf && info.tags.length === 0) {
    errors.push(
      `SKIPIF_WITHOUT_TAG: ${rel} uses .skipIf(...chromium...) but has no @chromium-skip comment with a gap-id. Add '// @chromium-skip — <gap-id>' on the skipped it().`,
    );
  }
}

// Invariant 2: every row in the table must reference a real spec.
const specNames = new Set(specs.map((s) => relative(ROOT, s).split(sep).join("/").split("/").pop()));
for (const row of tableRows) {
  // Heuristic: row.spec is the first cell — extract anything ending in .test.ts
  const m = row.spec.match(/[A-Za-z0-9_\-]+\.e2e\.test\.ts/);
  if (!m) continue; // row doesn't reference a file (skill table column may be tag only)
  const fname = m[0];
  if (!specNames.has(fname)) {
    errors.push(
      `STALE_TABLE_ROW: docs/known-chromium-gaps.md row references '${fname}' but no such spec exists in test/e2e/.`,
    );
  }
}

if (errors.length === 0) {
  // Helpful breadcrumb when run on a fresh repo with no skips yet.
  if (specs.length === 0) {
    console.log("check-chromium-skips: no e2e specs yet — nothing to check.");
  } else {
    console.log(`check-chromium-skips: OK (${specs.length} specs, ${tableRows.length} rows in gaps table).`);
  }
  process.exit(0);
}

console.error("check-chromium-skips: enforcement failed:");
for (const e of errors) console.error(`  - ${e}`);
process.exit(1);
