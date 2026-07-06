# macOS: Run as a Persistent Service (launchd)

Register `lynceus` as a launchd user agent so it starts automatically on login
and exposes the MCP SSE endpoint on `127.0.0.1:9719`.

Persistent service mode is useful for MCP clients that support SSE because the
`lynceus` process and its browser/CDP session can survive MCP client restarts or
reconnects. It does **not** persist state across service-process restarts.

> Security note: the local SSE endpoint has no authentication. MCP tools include
> in-page JavaScript evaluation and filesystem writes via screenshot paths. Only
> run a persistent service on trusted single-user machines, and do not bind it to
> non-loopback interfaces unless you understand the `--allow-remote` exposure.

> **Migrating from cdp-mcp?** An existing `cdp-mcp` service keeps working under
> its old Label `io.github.lcjanke2020.cdp-mcp` and `~/Library/Logs/cdp-mcp/`
> paths — no action required. To adopt the `lynceus` names used below, remove the
> old agent first: `launchctl bootout gui/$UID/io.github.lcjanke2020.cdp-mcp` and
> `rm ~/Library/LaunchAgents/io.github.lcjanke2020.cdp-mcp.plist`, then
> `npm install -g lynceus` and follow the steps below.

## Contents

- [1. Install the server](#1-install-the-server)
- [2. Create the plist](#2-create-the-plist)
- [3. Load and start](#3-load-and-start)
- [4. Verify](#4-verify)
- [5. Configure an MCP client](#5-configure-an-mcp-client)
- [6. Logs](#6-logs)
- [7. Stop / uninstall](#7-stop--uninstall)
- [8. Upgrade](#8-upgrade)
- [Troubleshooting](#troubleshooting)

## 1. Install the server

Requires Node.js 20+ and a local Chrome/Chromium browser.

```bash
npm install -g lynceus
```

Verify with `lynceus --help`. The package ships prebuilt `dist/`, so there is no
build step and no repo checkout needed.

If `launch_chrome` cannot find Chrome/Chromium automatically, set `CHROME_PATH`
in the plist generated below.

## 2. Create the plist

Run this from any directory:

```bash
# If you use fnm, nvm, or another Node version manager, set these variables to
# stable paths before running this snippet. Example:
# NODE_BIN="$HOME/.local/share/fnm/aliases/default/bin/node"
# LYNCEUS_SCRIPT="$HOME/.local/share/fnm/aliases/default/bin/lynceus"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LYNCEUS_SCRIPT="${LYNCEUS_SCRIPT:-$(command -v lynceus)}"
CHROME_PATH="${CHROME_PATH:-}"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH. Install Node 20+ first." >&2
  exit 1
fi
if [ -z "$LYNCEUS_SCRIPT" ]; then
  echo "Error: lynceus not found. Run 'npm install -g lynceus' first." >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" \
    | sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

NODE_DIR="$(dirname "$NODE_BIN")"
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/lynceus
ESC_NODE=$(xml_escape "$NODE_BIN")
ESC_NODE_DIR=$(xml_escape "$NODE_DIR")
ESC_LYNCEUS=$(xml_escape "$LYNCEUS_SCRIPT")
ESC_HOME=$(xml_escape "$HOME")
ESC_CHROME=$(xml_escape "$CHROME_PATH")
cat > ~/Library/LaunchAgents/io.github.lcjanke2020.lynceus.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.lcjanke2020.lynceus</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ESC_NODE</string>
    <string>$ESC_LYNCEUS</string>
    <string>--port</string>
    <string>9719</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$ESC_HOME/Library/Logs/lynceus/server.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$ESC_HOME/Library/Logs/lynceus/server.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$ESC_NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
$(if [ -n "$CHROME_PATH" ]; then printf '    <key>CHROME_PATH</key>\n    <string>%s</string>\n' "$ESC_CHROME"; fi)
  </dict>
</dict>
</plist>
PLIST
```

The plist invokes `node` directly with the `lynceus` script path. That makes the
`NODE_BIN` override authoritative even when your shell uses a Node version
manager.

## 3. Load and start

On macOS 10.15+, use:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/io.github.lcjanke2020.lynceus.plist
launchctl kickstart -k gui/$UID/io.github.lcjanke2020.lynceus
```

Older macOS releases also support:

```bash
launchctl load ~/Library/LaunchAgents/io.github.lcjanke2020.lynceus.plist
```

## 4. Verify

```bash
launchctl print gui/$UID/io.github.lcjanke2020.lynceus
lsof -i :9719
curl -v --max-time 2 http://127.0.0.1:9719/sse 2>&1 | head -20
```

The `curl` command should show a `200 OK` response and SSE event output. A
timeout after the first event is expected because `/sse` keeps the connection
open. The server also sends periodic SSE keepalive comments by default; tune
with `LYNCEUS_SSE_KEEPALIVE_MS` only if your MCP client needs a different idle
interval.

## 5. Configure an MCP client

Point an SSE-capable MCP client at:

```text
http://127.0.0.1:9719/sse
```

For example, clients that use JSON MCP server config commonly use:

```json
{
  "mcpServers": {
    "lynceus": {
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

## 6. Logs

```bash
tail -f ~/Library/Logs/lynceus/server.stderr.log
```

## 7. Stop / uninstall

```bash
launchctl bootout gui/$UID/io.github.lcjanke2020.lynceus
rm ~/Library/LaunchAgents/io.github.lcjanke2020.lynceus.plist
```

Older macOS releases also support:

```bash
launchctl unload ~/Library/LaunchAgents/io.github.lcjanke2020.lynceus.plist
```

## 8. Upgrade

```bash
npm install -g lynceus@latest
launchctl kickstart -k gui/$UID/io.github.lcjanke2020.lynceus
```

Restart or reconnect your MCP client after a server upgrade so it reloads tool
schemas.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `bootstrap` says service already loaded | Run `launchctl bootout gui/$UID/io.github.lcjanke2020.lynceus`, then bootstrap again |
| Service exits immediately | Check `~/Library/Logs/lynceus/server.stderr.log`; usually `lynceus` is not installed, Node is too old, or a version-manager path moved |
| Port 9719 is already in use | Check `lsof -i :9719`, then stop the other process or change the port in the plist |
| MCP client rejects the config | Confirm the client supports SSE MCP servers and include both `"type": "sse"` and the `/sse` URL if your client uses JSON config |
| `launch_chrome` cannot find Chrome | Set `CHROME_PATH` before generating the plist, or edit the plist environment and reload the service |
| Service not starting after reboot | Verify the plist is in `~/Library/LaunchAgents/`, not `LaunchDaemons` |
| Service not starting after reboot with fnm/nvm | Version-manager shell paths can be ephemeral. Recreate the plist with stable `NODE_BIN` and `LYNCEUS_SCRIPT` paths, or install with a system Node |
| `already_session` after reconnecting | The prior browser/CDP session is still alive. Resume it, or call `close_session` before starting fresh |
