// Environment-variable reads with backward-compatible fallback.
//
// The project was renamed cdp-mcp → lynceus. Branding env vars moved from the
// `CDP_MCP_*` prefix to `LYNCEUS_*`. To avoid breaking existing installs we
// read the new name first and fall back to the old one, emitting a one-time
// deprecation note per old var.
//
// The note is written directly to stderr (never via `util/log`): log.ts calls
// this helper at module load to resolve its own level, before its `threshold`
// is initialized — routing the warning through `log` would be a circular-init
// hazard. stdout is reserved for JSON-RPC framing, so stderr is the only safe
// sink anyway.

const warned = new Set<string>();

/**
 * Read `newName` from the environment, falling back to the deprecated
 * `oldName`. Returns the raw string (including `""`) or `undefined` when
 * neither is set. On first use of the old name, prints a one-line deprecation
 * note to stderr.
 */
export function envWithFallback(newName: string, oldName: string): string | undefined {
  const next = process.env[newName];
  if (next !== undefined) return next;

  const old = process.env[oldName];
  if (old !== undefined) {
    if (!warned.has(oldName)) {
      warned.add(oldName);
      process.stderr.write(`[lynceus] ${oldName} is deprecated; use ${newName}\n`);
    }
    return old;
  }

  return undefined;
}
