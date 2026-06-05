# Linux: Run as a Persistent Service (systemd)

Register `cdp-mcp` as a systemd user service so it starts automatically on login
and exposes the MCP SSE endpoint on `127.0.0.1:9719`. If you enable lingering,
the service can also start at boot before an interactive login.

Persistent service mode is useful for MCP clients that support SSE because the
`cdp-mcp` process and its browser/CDP session can survive MCP client restarts or
reconnects. It does **not** persist state across service-process restarts.

> Security note: the local SSE endpoint has no authentication. MCP tools include
> in-page JavaScript evaluation and filesystem writes via screenshot paths. Only
> run a persistent service on trusted single-user machines. Be especially careful
> with `loginctl enable-linger` on shared hosts because it widens the service's
> exposure window beyond your interactive login session.

## Contents

- [1. Install the server](#1-install-the-server)
- [2. Optional: enable lingering](#2-optional-enable-lingering)
- [3. Create the unit file](#3-create-the-unit-file)
- [4. Enable and start the service](#4-enable-and-start-the-service)
- [5. Verify](#5-verify)
- [6. Configure an MCP client](#6-configure-an-mcp-client)
- [7. Logs](#7-logs)
- [8. Stop / uninstall](#8-stop--uninstall)
- [9. Upgrade](#9-upgrade)
- [Linux ARM64 / Chromium](#linux-arm64--chromium)
- [Troubleshooting](#troubleshooting)

## 1. Install the server

Requires Node.js 20+ and a local Chrome/Chromium browser.

```bash
npm install -g cdp-mcp
```

Verify with `cdp-mcp --help`. The package ships prebuilt `dist/`, so there is no
build step and no repo checkout needed.

If `launch_chrome` cannot find Chrome/Chromium automatically, set `CHROME_PATH`
when generating the unit file below.

## 2. Optional: enable lingering

Enable lingering only if you want the user service to start at boot even before
you log in:

```bash
sudo loginctl enable-linger "$USER"
```

You only need to run this once per machine. Check with:

```bash
loginctl show-user "$USER" --property=Linger
```

Skip this step if starting the service during your login session is enough.

## 3. Create the unit file

Run this from any directory:

```bash
# If you use fnm, nvm, or another Node version manager, set these variables to
# stable paths before running this snippet. Example:
# NODE_BIN="$HOME/.local/share/fnm/aliases/default/bin/node"
# CDP_SCRIPT="$HOME/.local/share/fnm/aliases/default/bin/cdp-mcp"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CDP_SCRIPT="${CDP_SCRIPT:-$(command -v cdp-mcp)}"
CHROME_PATH="${CHROME_PATH:-}"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH. Install Node 20+ first." >&2
  exit 1
fi
if [ -z "$CDP_SCRIPT" ]; then
  echo "Error: cdp-mcp not found. Run 'npm install -g cdp-mcp' first." >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/cdp-mcp.service << EOF
[Unit]
Description=cdp-mcp browser MCP server (SSE on port 9719)
After=network.target

[Service]
Type=simple
ExecStart="${NODE_BIN}" "${CDP_SCRIPT}" --port 9719
Restart=on-failure
RestartSec=5
Environment="PATH=${NODE_DIR}:/usr/local/bin:/usr/bin:/bin"
$(if [ -n "$CHROME_PATH" ]; then printf 'Environment="CHROME_PATH=%s"\n' "$CHROME_PATH"; else printf '# Optional: set CHROME_PATH if launch_chrome cannot find Chrome/Chromium.\n# Environment="CHROME_PATH=/path/to/chrome"\n'; fi)

[Install]
WantedBy=default.target
EOF
```

The unit invokes `node` directly with the `cdp-mcp` script path. That makes the
`NODE_BIN` override authoritative even when your shell uses a Node version
manager. The `ExecStart` and `Environment` values are double-quoted so systemd
treats a path containing spaces as a single token rather than splitting it.

## 4. Enable and start the service

```bash
systemctl --user daemon-reload
systemctl --user enable --now cdp-mcp.service
```

## 5. Verify

```bash
systemctl --user status cdp-mcp.service
ss -tlnp | grep 9719
curl -s --max-time 2 http://127.0.0.1:9719/sse | head -1
```

The `curl` command should print an SSE `event:` line. The stream stays open by
design. The server also sends periodic SSE keepalive comments by default; tune
with `CDP_MCP_SSE_KEEPALIVE_MS` only if your MCP client needs a different idle
interval.

## 6. Configure an MCP client

Point an SSE-capable MCP client at:

```text
http://127.0.0.1:9719/sse
```

For example, clients that use JSON MCP server config commonly use:

```json
{
  "mcpServers": {
    "cdp-mcp": {
      "type": "sse",
      "url": "http://127.0.0.1:9719/sse"
    }
  }
}
```

SSE mode is single-client today. Multiple MCP clients connected to the same
service share one process-global browser/CDP session and can interfere with each
other. Use one active debugging client per service, or run separate services on
separate ports.

A reconnecting client resumes the prior session. If you want a clean browser
session after reconnecting, call `close_session` before launching or attaching
again.

## 7. Logs

```bash
journalctl --user -u cdp-mcp.service -f
journalctl --user -u cdp-mcp.service -n 100
```

## 8. Stop / uninstall

```bash
systemctl --user stop cdp-mcp.service
systemctl --user disable cdp-mcp.service
rm ~/.config/systemd/user/cdp-mcp.service
systemctl --user daemon-reload
```

## 9. Upgrade

```bash
npm install -g cdp-mcp@latest
systemctl --user restart cdp-mcp.service
```

Restart or reconnect your MCP client after a server upgrade so it reloads tool
schemas.

## Linux ARM64 / Chromium

Google does not publish official Chrome builds for Linux ARM64. If your distro's
Chromium package is unreliable for DevTools Protocol launches, use a
Playwright-cached Chromium binary and set `CHROME_PATH` when generating the
unit:

```bash
# Install Playwright's Chromium (one-time):
npx playwright install chromium

# Set CHROME_PATH to the latest revision before running the unit-file script:
export CHROME_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux/chrome"
```

Snap Chromium (`/snap/bin/chromium`) can be unreliable for persistent services
because snap confinement may interfere with `--remote-debugging-port`, headless
flags, and process lifecycle management. A Playwright-cached Chromium is often
more predictable for CDP-based debugging sessions. The generated unit's `PATH`
does not include `/snap/bin`, so if you do use snap Chromium you must set
`CHROME_PATH=/snap/bin/chromium` explicitly — `launch_chrome` will not
auto-detect it under the service environment.

Playwright upgrades may relocate the binary. After running
`npx playwright install chromium`, check the new revision directory name (for
example, `chromium-1223` to `chromium-1250`), update `CHROME_PATH` in the unit
file, and run:

```bash
systemctl --user daemon-reload
systemctl --user restart cdp-mcp.service
```

For Chromium sandbox flags (`--no-sandbox`, AppArmor, snap confinement) and known
host-OS launch gaps, see [chromium-sandboxing.md](./chromium-sandboxing.md) and
[known-chromium-gaps.md](./known-chromium-gaps.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Service exits immediately | Check `journalctl --user -u cdp-mcp.service -n 100`; usually `cdp-mcp` is not installed, Node is too old, or a version-manager path moved |
| Port 9719 is already in use | Compare `systemctl --user show -p MainPID --value cdp-mcp.service` with `ss -tlnp \| grep 9719`, then stop the other process or change the port |
| MCP client rejects the config | Confirm the client supports SSE MCP servers and include both `"type": "sse"` and the `/sse` URL if your client uses JSON config |
| `launch_chrome` cannot find Chrome | Set `CHROME_PATH` in the unit file and restart the service; on Linux ARM64, try Playwright-cached Chromium (`~/.cache/ms-playwright/chromium-*/chrome-linux/chrome`) |
| Service not starting after reboot | Enable lingering with `sudo loginctl enable-linger "$USER"` |
| Node not found after reboot with fnm/nvm | Version-manager shell paths can be ephemeral. Recreate the unit with stable `NODE_BIN` and `CDP_SCRIPT` paths, or install with a system Node |
| `Failed to connect to bus` over SSH | Run `export XDG_RUNTIME_DIR=/run/user/$(id -u)` before using `systemctl --user` |
| `already_session` after reconnecting | The prior browser/CDP session is still alive. Resume it, or call `close_session` before starting fresh |
