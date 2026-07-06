#!/usr/bin/env node
// Smoke test: start the built MCP server on stdio, run the standard MCP
// initialize handshake, fetch the tool list, and pretty-print the names.
//
// This doesn't touch a browser — it only verifies the protocol surface so
// you can catch regressions in tool registration without needing Chrome.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const responses = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && responses.has(msg.id)) {
        responses.get(msg.id)(msg);
        responses.delete(msg.id);
      }
    } catch {
      // ignore lines we can't parse
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    responses.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "lynceus-smoke", version: "0.0.1" },
});
console.log("initialize:", init.result.serverInfo);
notify("notifications/initialized");

const list = await send("tools/list");
const names = list.result.tools.map((t) => t.name);
const requiredTools = ["locate", "wait_for", "get_form_state"];
const missingTools = requiredTools.filter((name) => !names.includes(name));
if (missingTools.length > 0) {
  console.error(`missing required tools: ${missingTools.join(", ")}`);
  child.stdin.end();
  child.kill();
  process.exit(1);
}
console.log(`tools (${names.length}):`);
for (const n of names) console.log("  -", n);

child.stdin.end();
child.kill();
process.exit(0);
