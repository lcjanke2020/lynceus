import { createServer } from "node:http";

const server = createServer((req, res) => {
  const requestPath = req.url ?? "/";

  if (req.method === "GET" && requestPath === "/api/x") {
    const payload = { message: "backend-ok", requestPath }; // L3 breakpoint target (fullstack-flow:7)
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify({ error: "not-found", requestPath }));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fullstack-api did not receive a TCP address");
  }
  process.stdout.write(
    `sample-node-app fullstack-api listening on http://127.0.0.1:${address.port}\n`,
  );
});
