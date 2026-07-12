/**
 * Production entry for npm start (Cloudflare Containers, GoDaddy PaaS, local, and cPanel Passenger).
 * package.json "main" points here; "start" runs: node app.js
 */
const backend = require("./backend/server.js");

const handleRequest =
  typeof backend.handleRequest === "function" ? backend.handleRequest : backend;
const startProductionServer = backend.startProductionServer;
const isPassengerRuntime =
  typeof backend.isPassengerRuntime === "function"
    ? backend.isPassengerRuntime
    : () => false;

if (isPassengerRuntime()) {
  module.exports = handleRequest;
} else if (typeof startProductionServer === "function") {
  startProductionServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[app.js] start failed:", err);
    process.exit(1);
  });
} else {
  const http = require("http");
  const port = Number(process.env.PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be set by the host. Got: ${JSON.stringify(process.env.PORT)}`);
  }
  http.createServer(handleRequest).listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`Listening on 0.0.0.0:${port}`);
  });
}
