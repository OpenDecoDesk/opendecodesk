// Timing helpers: run an operation a warm-up time and then `runs` times, and keep the numbers.
// Also watches memory: this Node process and the workerd process Miniflare runs the Worker in.
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return { median: q(0.5), p95: q(0.95), min: v[0], max: v[v.length - 1], n: v.length };
}

// Times one operation. `call(i)` makes call i and returns perf/lib/server.js's { status, ms, bytes, body, timeout }.
// A failed answer stops the operation (its error is kept); a timeout the same.
async function timeOp(call, { runs = 5, warmup = 1, rowsOf }) {
  const times = [];
  let bytes = 0, rows = 0, error = null, timeout = false;
  for (let i = 0; i < warmup + runs; i++) {
    let r;
    try { r = await call(i); }
    catch (e) { error = String(e && e.message || e); break; }
    if (r.timeout) { timeout = true; error = "timed out after " + Math.round(r.ms / 1000) + " s"; break; }
    const bad = r.status !== 200 || (r.body && (r.body.status === "error" || (Array.isArray(r.body.skipped) && r.body.skipped.length && !r.body.updated)));
    if (bad) { error = "HTTP " + r.status + ": " + String((r.body && (r.body.message || JSON.stringify(r.body.skipped || r.body.errors || "").slice(0, 200))) || r.text || "").slice(0, 300); break; }
    if (r.body && Array.isArray(r.body.errors) && r.body.errors.length) { error = "partly refused: " + String(r.body.errors[0]).slice(0, 200); break; }
    if (i >= warmup) times.push(r.ms);
    bytes = r.bytes; rows = rowsOf ? rowsOf(r.body) : 0;
  }
  return { ...(stats(times) || {}), times, bytes, rows, error, timeout };
}

// Resident memory (MB) of this process and of every workerd under it, sampled until stop().
function memorySampler(intervalMs = 500) {
  let peakNode = 0, peakWorkerd = 0, timer = null, busy = false;
  const sample = () => {
    if (busy) return; busy = true;
    peakNode = Math.max(peakNode, process.memoryUsage().rss / 1048576);
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], (err, out) => {
      busy = false;
      if (err) return;
      const rows = out.trim().split("\n").map(l => l.trim().split(/\s+/)).map(([pid, ppid, rss, ...c]) => ({ pid: +pid, ppid: +ppid, rss: +rss, comm: c.join(" ") }));
      const mine = new Set([process.pid]);
      for (let grew = true; grew;) { grew = false; for (const r of rows) if (mine.has(r.ppid) && !mine.has(r.pid)) { mine.add(r.pid); grew = true; } }
      const w = rows.filter(r => mine.has(r.pid) && /workerd/.test(r.comm)).reduce((a, r) => a + r.rss, 0) / 1024;
      peakWorkerd = Math.max(peakWorkerd, w);
    });
  };
  return {
    start() { sample(); timer = setInterval(sample, intervalMs); return this; },
    stop() { clearInterval(timer); sample(); return { nodeMB: Math.round(peakNode), workerdMB: Math.round(peakWorkerd) }; },
  };
}

// Size in bytes of every file under a folder.
function folderBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? folderBytes(p) : fs.statSync(p).size;
  }
  return total;
}

module.exports = { stats, timeOp, memorySampler, folderBytes };
