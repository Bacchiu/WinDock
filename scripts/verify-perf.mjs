/** System monitor: parsing, lazy sampling, GPU fallback, and the /api/perf route. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPerfMonitor, parseGpuLine, nvidiaSmiPath } from "../src/perf.js";
import { heat, formatBytes } from "../public/monitor.js";
import { createApp } from "../server.js";

// nvidia-smi CSV parsing, including laptops that report [N/A] for the fan.
assert.deepEqual(parseGpuLine("0, NVIDIA GeForce RTX 4070, 61, 37, 2048, 12282, 115.32, 42"),
  { index: 0, name: "NVIDIA GeForce RTX 4070", temp: 61, usage: 37, vramUsed: 2048, vramTotal: 12282, power: 115.32, fan: 42 });
assert.equal(parseGpuLine("0, RTX 3060 Laptop GPU, 55, 3, 100, 6144, [N/A], [N/A]").fan, null);
assert.equal(parseGpuLine("garbage"), null);
assert.equal(nvidiaSmiPath("win32", { SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\nvidia-smi.exe");

// Heat bands drive the hero background.
assert.equal(heat(45).band, "cool"); assert.equal(heat(45).hue, 155);
assert.equal(heat(70).band, "normal"); assert.equal(heat(80).band, "warm");
assert.equal(heat(90).band, "hot"); assert.equal(heat(95).hue, 0); assert.ok(heat(70).hue > 85, "normal temps still read as green-ish");
assert.equal(heat(undefined).band, "unknown");
assert.equal(formatBytes(16 * 1024 ** 3), "16 GB");

// Fake clock, timers, OS and nvidia-smi process.
let clock = 0, tickFn = null;
const timers = { setInterval: (fn) => { tickFn = fn; return { unref() {} }; }, clearInterval: () => { tickFn = null; } };
let idle = 0, busy = 0;
const os = {
  cpus: () => [{ model: "Test CPU", times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }, { model: "Test CPU", times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }],
  totalmem: () => 16 * 1024 ** 3, freemem: () => 4 * 1024 ** 3,
};
const spawned = [];
function fakeSpawn(command, args, options) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  spawned.push({ command, args, options, proc });
  return proc;
}

const perf = createPerfMonitor({ os, spawn: fakeSpawn, platform: "win32", now: () => clock, idleMs: 5000, ...timers });
let snap = perf.snapshot();
assert.equal(perf.running, true, "first request starts sampling");
assert.equal(snap.cpu.usage, null, "no CPU reading before the first interval");
assert.equal(snap.cpu.cores, 2);
assert.equal(snap.ram.usage, 75);
assert.equal(snap.gpuStatus, "starting");
assert.equal(spawned.length, 1);
assert.match(spawned[0].command, /nvidia-smi\.exe$/);
assert.ok(spawned[0].args.includes("-lms"), "one long-running nvidia-smi, not one per sample");
assert.equal(spawned[0].options.windowsHide, true);

// Stream a reading for two GPUs split across chunks; only GPU 0 is used.
spawned[0].proc.stdout.emit("data", "0, RTX 4070, 6");
spawned[0].proc.stdout.emit("data", "4, 37, 2048, 12282, 115.3, 42\r\n1, Other GPU, 99, 99, 1, 2, 3, 4\n");
busy += 300; idle += 700; clock += 1000; tickFn();
snap = perf.snapshot();
assert.equal(snap.cpu.usage, 30, "CPU usage from OS time deltas");
assert.equal(snap.gpuStatus, "ok");
assert.equal(snap.gpu.temp, 64);
assert.equal(snap.gpu.name, "RTX 4070");
assert.equal(snap.history.length, 1);
assert.deepEqual({ cpu: snap.history[0].cpu, gpu: snap.history[0].gpu, gpuTemp: snap.history[0].gpuTemp }, { cpu: 30, gpu: 37, gpuTemp: 64 });

// Idle: sampling and nvidia-smi stop when nobody is looking.
clock += 6000; tickFn();
assert.equal(perf.running, false, "stops after idle");
assert.equal(spawned[0].proc.killed, true, "nvidia-smi is stopped");

// No NVIDIA GPU: report unavailable and don't respawn on every sample.
const missing = [];
const perfMissing = createPerfMonitor({ os, platform: "linux", now: () => clock, ...timers,
  spawn: (...args) => { const p = fakeSpawn(...args); missing.push(p); queueMicrotask(() => p.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }))); return p; } });
perfMissing.snapshot();
await new Promise((resolve) => setImmediate(resolve));
clock += 1000; tickFn();
snap = perfMissing.snapshot();
assert.equal(snap.gpuStatus, "unavailable");
assert.equal(snap.gpu, null);
assert.equal(missing.length, 1, "no respawn storm when nvidia-smi is missing");
perfMissing.stop();

// Route: needs pairing, returns the snapshot.
const app = await createApp({ provider: { id: "test", displayName: "Test", listRunningApps: async () => [] },
  configStore: { load: async () => ({ tiles: [] }) }, pin: "135790", trustLoopback: false,
  perf: createPerfMonitor({ os, spawn: fakeSpawn, now: () => clock, ...timers }) });
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + app.server.address().port;
try {
  assert.equal((await fetch(base + "/api/perf")).status, 401, "monitor requires pairing");
  const auth = await fetch(base + "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "135790" }) });
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const res = await fetch(base + "/api/perf", { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ram.usage, 75);
  assert.ok(Array.isArray(body.history));
} finally {
  app.server.close();
  await Promise.all([app.hub.close(), app.inputHub.close()]);
}
console.log("perf verification passed");
