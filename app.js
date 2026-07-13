/**
 * Production entry for npm start (Cloudflare Containers, GoDaddy PaaS, local, and cPanel Passenger).
 * package.json "main" points here; "start" runs: node app.js
 *
 * Important for Cloudflare Containers: bind PORT immediately, then load the heavy
 * backend. Port checks fail if we `require("./backend/server.js")` before listen().
 */
const http = require("http");

const isPassengerRuntime = () =>
  Boolean(
    process.env.PASSENGER_APP_ENV ||
      String(process.env.PHUSION_PASSENGER || "").toLowerCase() === "true" ||
      String(process.env.PHUSION_PASSENGER || "") === "1"
  );

if (isPassengerRuntime()) {
  // Passenger wants a request handler export; load backend synchronously.
  const backend = require("./backend/server.js");
  module.exports =
    typeof backend.handleRequest === "function" ? backend.handleRequest : backend;
} else {
  const port = Number(process.env.PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be set by the host. Got: ${JSON.stringify(process.env.PORT)}`);
  }

  let handleRequest = (req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, booting: true, port }));
  };

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err?.message || "Server error" }));
    }
  });

  server.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`[app.js] boot listener ready on 0.0.0.0:${port}`);
  });

  server.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[app.js] listen failed:", err);
    process.exit(1);
  });

  // Load the real app after the port is open so container health checks can pass.
  setImmediate(() => {
    try {
      const backend = require("./backend/server.js");
      handleRequest =
        typeof backend.handleRequest === "function" ? backend.handleRequest : backend;
      // eslint-disable-next-line no-console
      console.log("[app.js] backend handler attached");

      if (typeof backend.bootstrapAfterListen === "function") {
        backend.bootstrapAfterListen().catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[app.js] bootstrap failed:", err);
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[app.js] backend load failed:", err);
      handleRequest = (_req, res) => {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({ ok: false, error: err?.message || "Backend failed to load" })
        );
      };
    }
  });
}
