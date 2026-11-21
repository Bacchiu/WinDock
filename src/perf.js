/**
 * Live system monitor: CPU and RAM usage from the OS, NVIDIA GPU usage,
 * temperature, VRAM and power from nvidia-smi (installed with the driver).
 *
 * Runs only while someone is looking: the first request starts sampling and
 * it stops after `idleMs` without requests. No admin rights, no drivers, no
 * network. nvidia-smi is a fixed system path with fixed arguments.
 */
import nodeOs from "node:os";
import { spawn as nodeSpawn } from "node:child_process";

const HISTORY = 120;
const GPU_FIELDS = "index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,fan.speed";

export function nvidiaSmiPath(platform = process.platform, env = process.env) {
  if (platform === "win32") return (env.SystemRoot || "C:\\Windows") + "\\System32\\nvidia-smi.exe";
  return "nvidia-smi";
}

function number(text) {
  const value = Number.parseFloat(String(text).trim());
  return Number.isFinite(value) ? value : null;
}

/** Parse one CSV line from nvidia-smi (noheader, nounits). */
export function parseGpuLine(line) {
  const parts = String(line).split(",").map((part) => part.trim());
  if (parts.length < 8) return null;
  const [index, name, temp, usage, vramUsed, vramTotal, power, fan] = parts;
  if (number(index) === null) return null;
  return {
    index: number(index), name: name.slice(0, 80),
    temp: number(temp), usage: number(usage),
    vramUsed: number(vramUsed), vramTotal: number(vramTotal),
    power: number(power), fan: number(fan),
  };
}

function cpuTimes(os) {
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export function createPerfMonitor({ os = nodeOs, spawn = nodeSpawn, platform = process.platform,
  intervalMs = 1000, idleMs = 20000, gpuRetryMs = 60000, now = Date.now,
  setInterval: every = setInterval, clearInterval: stopEvery = clearInterval } = {}) {
  let timer = null, child = null, lastTouch = 0, lastTimes = null;
  let cpu = null, gpu = null, gpuStatus = "starting", gpuFailedAt = -Infinity;
  const history = [];

  function startGpu() {
    if (child || now() - gpuFailedAt < gpuRetryMs) return;
    gpuStatus = "starting";
    let buffer = "";
    try {
      child = spawn(nvidiaSmiPath(platform), [
        "--query-gpu=" + GPU_FIELDS, "--format=csv,noheader,nounits", "-lms", String(intervalMs),
      ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      child = null; gpuStatus = "unavailable"; gpuFailedAt = now(); return;
    }
    const proc = child;
    proc.stdout.setEncoding?.("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer = (buffer + chunk).slice(-8192);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const reading = parseGpuLine(line);
        if (reading && reading.index === 0) { gpu = reading; gpuStatus = "ok"; }
      }
    });
    const failed = () => {
      if (child !== proc) return;
      child = null; gpu = null; gpuStatus = "unavailable"; gpuFailedAt = now();
    };
    proc.on("error", failed);
    proc.on("exit", failed);
  }

  function stopGpu() {
    const proc = child;
    child = null;
    if (proc) { try { proc.kill(); } catch { /* already gone */ } }
  }

  function sample() {
    if (now() - lastTouch > idleMs) return stop();
    const times = cpuTimes(os);
    if (lastTimes && times.total > lastTimes.total) {
      const busy = 1 - (times.idle - lastTimes.idle) / (times.total - lastTimes.total);
      cpu = Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
    }
    lastTimes = times;
    if (!child) startGpu();
    const total = os.totalmem(), used = total - os.freemem();
    history.push({ t: now(), cpu, ram: Math.round(used / total * 1000) / 10,
      gpu: gpu?.usage ?? null, gpuTemp: gpu?.temp ?? null });
    if (history.length > HISTORY) history.shift();
  }

  function stop() {
    if (timer) { stopEvery(timer); timer = null; }
    stopGpu();
    lastTimes = null; cpu = null; gpu = null;
    if (gpuStatus === "ok") gpuStatus = "starting";
    history.length = 0;
  }

  function touch() {
    lastTouch = now();
    if (!timer) {
      lastTimes = cpuTimes(os);
      startGpu();
      timer = every(sample, intervalMs);
      timer.unref?.();
    }
  }

  return {
    snapshot() {
      touch();
      const total = os.totalmem(), used = total - os.freemem();
      const cpus = os.cpus();
      return {
        cpu: { usage: cpu, cores: cpus.length, model: String(cpus[0]?.model || "").trim().slice(0, 80) },
        ram: { used, total, usage: Math.round(used / total * 1000) / 10 },
        gpu: gpuStatus === "ok" ? { ...gpu } : null,
        gpuStatus,
        history: history.slice(),
      };
    },
    stop,
    get running() { return Boolean(timer); },
  };
}
