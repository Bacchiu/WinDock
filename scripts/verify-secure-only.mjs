/** Hardened build: phones on the LAN must use secure pairing; plain HTTP is PC-only. */
import assert from "node:assert/strict";
import { request } from "node:http";
import { WebSocket } from "ws";
import { createApp } from "../server.js";
import { createLockout } from "../src/auth.js";

const provider = { id: "test", displayName: "Test", listRunningApps: async () => [] };
const configStore = { load: async () => ({ tiles: [] }) };
const PIN = "123456";
delete process.env.WINDOCK_ALLOW_INSECURE;

const app = await createApp({ provider, configStore, pin: PIN, lockout: createLockout({ maxFails: 100 }) });
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const port = app.server.address().port;
// A LAN Host header from a loopback socket is not "local", so it stands in for a phone.
const LAN = "192.168.1.1:" + port;

function call(path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* static file */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function websocketStatus(path, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port + path, { headers, handshakeTimeout: 2000 });
    ws.once("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.once("open", () => { ws.terminate(); resolve(101); });
    ws.on("error", reject);
  });
}

try {
  // The PC itself keeps working over loopback (tray, pairing page, local browser).
  assert.equal((await call("/api/state")).status, 200, "loopback still works");
  // Discovery can still identify the PC.
  const health = await call("/health", { headers: { host: LAN } });
  assert.equal(health.status, 200);
  assert.equal(health.json.app, "windock");

  // A phone on plain HTTP can neither pair with the PIN nor load the dock.
  const pin = await call("/api/auth", { method: "POST", body: { pin: PIN }, headers: { host: LAN } });
  assert.equal(pin.status, 403, "legacy PIN pairing over HTTP is refused");
  assert.equal(pin.json.error, "secure-only");
  assert.equal(pin.headers["set-cookie"], undefined, "no session is issued");
  for (const path of ["/", "/index.html", "/api/state", "/api/stats", "/api/clipboard/history"]) {
    assert.equal((await call(path, { headers: { host: LAN } })).status, 403, path + " is refused over HTTP");
  }
  const control = await call("/api/control", { method: "POST", body: { verb: "mute" }, headers: { host: LAN } });
  assert.equal(control.status, 403);
  for (const path of ["/", "/input"]) {
    assert.equal(await websocketStatus(path, { host: LAN, origin: "http://" + LAN }), 401, path + " upgrade refused over HTTP");
  }

  // Explicit opt-out restores the upstream behaviour.
  const legacy = await createApp({ provider, configStore, pin: PIN, lockout: createLockout({ maxFails: 100 }), allowInsecure: true });
  await new Promise((resolve) => legacy.server.listen(0, "127.0.0.1", resolve));
  const legacyPort = legacy.server.address().port;
  const status = await new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: legacyPort, path: "/api/auth", method: "POST",
      headers: { host: "192.168.1.1:" + legacyPort } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(JSON.stringify({ pin: PIN }));
  });
  assert.equal(status, 200, "WINDOCK_ALLOW_INSECURE restores PIN pairing");
  legacy.server.close();
  await Promise.all([legacy.hub.close(), legacy.inputHub.close()]);
} finally {
  app.server.close();
  await Promise.all([app.hub.close(), app.inputHub.close()]);
}
console.log("secure-only verification passed");
