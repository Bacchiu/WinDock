// Live system monitor: big GPU temperature with a heat-coloured background,
// smaller CPU / GPU / RAM usage cards. Polls only while the sheet is open.

/** Heat band and background hue for a GPU temperature in °C. */
export function heat(temp) {
  if (typeof temp !== "number") return { band: "unknown", label: "No reading", hue: null };
  // Green while cool, lime when normal, amber when warm, red when hot.
  const stops = [[45, 155], [60, 130], [75, 75], [85, 30], [92, 0]];
  let hue = temp <= stops[0][0] ? stops[0][1] : 0;
  for (let i = 1; i < stops.length; i++) {
    const [t0, h0] = stops[i - 1], [t1, h1] = stops[i];
    if (temp > t0 && temp <= t1) hue = h0 + (temp - t0) / (t1 - t0) * (h1 - h0);
  }
  hue = Math.round(hue);
  const band = temp < 60 ? "cool" : temp < 75 ? "normal" : temp < 85 ? "warm" : "hot";
  return { band, hue, label: { cool: "Cool", normal: "Normal", warm: "Warm", hot: "Hot" }[band] };
}

export function formatBytes(bytes) {
  if (typeof bytes !== "number") return "–";
  const gb = bytes / 1024 ** 3;
  return (gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)) + " GB";
}

const pct = (value) => typeof value === "number" ? Math.round(value) + "%" : "–";

function drawSpark(canvas, values, { min = 0, max = 100, color = "#b4edcc", fill = true } = {}) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const points = values.map((v, i) => [i, v]).filter(([, v]) => typeof v === "number");
  if (points.length < 2) return;
  const slots = Math.max(60, values.length - 1);
  const x = (i) => width - (values.length - 1 - i) / slots * width;
  const y = (v) => height - 2 - (Math.min(max, Math.max(min, v)) - min) / (max - min) * (height - 4);
  ctx.beginPath();
  points.forEach(([i, v], n) => n ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.strokeStyle = color; ctx.stroke();
  if (fill) {
    ctx.lineTo(x(points.at(-1)[0]), height); ctx.lineTo(x(points[0][0]), height); ctx.closePath();
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, color + "55"); gradient.addColorStop(1, color + "00");
    ctx.fillStyle = gradient; ctx.fill();
  }
}

export function createMonitor({ api, get = (id) => document.getElementById(id) }) {
  const dialog = get("monitor");
  let timer = null, busy = false, last = null;

  function paint(data) {
    last = data;
    const gpu = data.gpu, temp = gpu?.temp;
    const h = heat(temp);
    const hero = get("monitor-hero");
    hero.dataset.band = h.band;
    hero.style.setProperty("--heat-hue", h.hue ?? 190);
    get("monitor-temp").textContent = typeof temp === "number" ? Math.round(temp) : "–";
    get("monitor-band").textContent = gpu ? h.label : data.gpuStatus === "starting" ? "Reading sensors…" : "NVIDIA GPU not found";
    get("monitor-gpu-name").textContent = gpu?.name || "GPU temperature";
    get("monitor-fan").textContent = typeof gpu?.fan === "number" ? "Fan " + Math.round(gpu.fan) + "%" : "";
    get("monitor-power").textContent = typeof gpu?.power === "number" ? Math.round(gpu.power) + " W" : "";

    get("monitor-cpu").textContent = pct(data.cpu?.usage);
    get("monitor-cpu-detail").textContent = data.cpu?.cores ? data.cpu.cores + " threads" : "";
    get("monitor-gpu").textContent = pct(gpu?.usage);
    get("monitor-gpu-detail").textContent = gpu && typeof gpu.vramTotal === "number"
      ? "VRAM " + (gpu.vramUsed / 1024).toFixed(1) + " / " + (gpu.vramTotal / 1024).toFixed(0) + " GB" : "";
    get("monitor-ram").textContent = pct(data.ram?.usage);
    get("monitor-ram-detail").textContent = formatBytes(data.ram?.used) + " / " + formatBytes(data.ram?.total);
    for (const [id, value] of [["cpu", data.cpu?.usage], ["gpu", gpu?.usage], ["ram", data.ram?.usage]])
      get("monitor-" + id + "-bar").style.setProperty("--value", typeof value === "number" ? value : 0);
    drawCharts();
  }

  function drawCharts() {
    if (!last) return;
    const history = last.history || [];
    drawSpark(get("monitor-temp-chart"), history.map((s) => s.gpuTemp), { min: 25, max: 95, color: "#ffffff" });
    drawSpark(get("monitor-cpu-chart"), history.map((s) => s.cpu), { color: "#b4edcc" });
    drawSpark(get("monitor-gpu-chart"), history.map((s) => s.gpu), { color: "#9fd3ff" });
    drawSpark(get("monitor-ram-chart"), history.map((s) => s.ram), { color: "#d8c3ff" });
  }

  async function tick() {
    if (busy || !dialog.open || document.hidden) return;
    busy = true;
    try { paint(await api("/api/perf")); get("monitor-status").textContent = ""; }
    catch { get("monitor-status").textContent = "Can't reach your PC. Retrying…"; }
    finally { busy = false; }
  }

  function stop() { clearInterval(timer); timer = null; }
  dialog.addEventListener("close", stop);
  window.addEventListener("resize", drawCharts);

  return {
    open() {
      get("drawer")?.close();
      if (!dialog.open) dialog.showModal();
      stop(); tick(); timer = setInterval(tick, 1000);
    },
  };
}
