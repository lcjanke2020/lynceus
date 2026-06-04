# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Use GitHub's [private vulnerability reporting](https://github.com/lcjanke2020/cdp-mcp/security/advisories/new)
(Security → Advisories → "Report a vulnerability") so the report stays
confidential until a fix is available.

Include enough detail to reproduce: affected version/commit, environment, and
a minimal repro if possible. You can expect an initial acknowledgement within a
few days. This is an alpha-stage hobby project maintained on a best-effort
basis — there is no formal SLA, but credible reports will be taken seriously.

## Security model — read before deploying

`cdp-mcp` is a debugger. By design it can launch and attach to a Chromium
browser, set breakpoints, evaluate arbitrary expressions in page/runtime
contexts, read the DOM, and capture console + network traffic. Treat access to
this server as **equivalent to code execution and full read access** on every
target it is attached to.

- **stdio transport (default).** The server speaks MCP over stdin/stdout and is
  launched as a child process by the host (e.g. Claude Code). It exposes no
  network listener. This is the recommended mode.
- **SSE transport (`--port`).** Binds to `127.0.0.1` (loopback) by default. Do
  **not** bind it to a public interface or place it behind a reverse proxy
  without authentication — anyone who can reach the port gains the full
  debugger capability described above. There is no built-in authentication.
- **Target trust.** Only attach to browsers/pages you trust. `evaluate` and the
  breakpoint/console/network tools surface page content to the calling agent;
  point it only at content you are authorized to inspect.
- **Chromium sandboxing.** Some environments require `--no-sandbox` to launch
  Chromium. Understand the trade-offs in
  [docs/chromium-sandboxing.md](./docs/chromium-sandboxing.md) before disabling
  the sandbox, especially when loading untrusted pages.

## Supported versions

This project is pre-1.0. Only the latest released version receives fixes.
