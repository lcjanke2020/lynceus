// Normalize the messy URLs that bundlers emit into source maps and CDP scripts.
//
// Examples we want to fold to "src/foo.ts":
//   webpack:///./src/foo.ts
//   webpack-internal:///./src/foo.ts
//   webpack://app/./src/foo.ts
//   ./src/foo.ts
//   /src/foo.ts
//   file:///C:/proj/src/foo.ts
//
// We don't try to resolve to an absolute on-disk path — we only need stable
// matching keys so a user-supplied "src/foo.ts" can be located.

const KNOWN_PREFIXES = [
  /^webpack-internal:\/\/\/(?:\.\/)?/,
  /^webpack:\/\/[^/]*\/(?:\.\/)?/,
  /^webpack:\/\/\/(?:\.\/)?/,
  /^rollup:\/\/(?:\.\/)?/,
  /^vite-fs:\/\/(?:\.\/)?/,
  /^source-map:\/\/(?:\.\/)?/,
];

export function normalizeSourcePath(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  for (const re of KNOWN_PREFIXES) {
    if (re.test(s)) {
      s = s.replace(re, "");
      break;
    }
  }
  if (s.startsWith("file://")) {
    s = s.slice("file://".length);
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  }
  // strip a single leading slash for matching
  if (s.startsWith("/")) s = s.slice(1);
  if (s.startsWith("./")) s = s.slice(2);
  return s.replace(/\\/g, "/");
}

// Does `candidate` look like the same file as `query`?
// We accept matches where one is a strict suffix of the other on path segments.
export function pathMatches(candidate: string, query: string): boolean {
  const c = normalizeSourcePath(candidate);
  const q = normalizeSourcePath(query);
  if (c === q) return true;
  const cs = c.split("/").filter(Boolean);
  const qs = q.split("/").filter(Boolean);
  if (cs.length === 0 || qs.length === 0) return false;
  if (cs.length >= qs.length) {
    return cs.slice(-qs.length).join("/") === qs.join("/");
  }
  return qs.slice(-cs.length).join("/") === cs.join("/");
}
