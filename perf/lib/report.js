// The scale test's report: report.html (a page with charts, no outside files), plus the short
// tables scale.js prints. The page is written without <html>/<head>/<body> so it can be published
// as is; a browser opens it locally the same.
const fs = require("fs");

const esc = (s) => String(s === undefined || s === null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtMs = (ms) => ms === undefined || ms === null ? "–" : ms < 10 ? ms.toFixed(1) + " ms" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + " s";
const fmtN = (n) => n >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + "M" : n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + "k" : String(n);
const fmtBytes = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + " GB" : b >= 1048576 ? (b / 1048576).toFixed(0) + " MB" : (b / 1024).toFixed(0) + " KB";

// How time grows with the history: the slope of log(time) against log(orders), fitted over the
// steps from 5k up (the smallest step is mostly fixed overhead). 0 = flat, 1 = in proportion.
function growth(points) {
  let p = points.filter(x => x.y > 0);
  if (p.filter(x => x.x >= 5000).length >= 2) p = p.filter(x => x.x >= 5000);
  if (p.length < 2) return null;
  const xs = p.map(q => Math.log(q.x)), ys = p.map(q => Math.log(q.y));
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : null;
}

// Everything the page and the console say about one operation.
function analyse(results) {
  const out = [];
  for (const op of results.ops) {
    const cls = results.classes[op.cls];
    const pts = results.tiers.map(t => ({ x: t.orders, r: t.ops[op.name] })).filter(p => p.r);
    const good = pts.filter(p => !p.r.error && !p.r.skipped && p.r.median !== undefined);
    const series = good.map(p => ({ x: p.x, y: p.r.median, p95: p.r.p95, rows: p.r.rows, bytes: p.r.bytes }));
    const k = growth(series);
    const failed = pts.find(p => p.r.error);
    let over = null;
    if (cls.limitMs) for (const p of good) if (p.r.p95 > cls.limitMs) { over = p; break; }
    const overJudged = over && over.x <= cls.judgeUpTo;
    // A fixed window (last 30 days, open orders) that slows down while its answer stays the same size.
    let windowed = null;
    if (op.windowed && series.length >= 2) {
      const a = series[0], b = series[series.length - 1];
      const tGrow = b.y / a.y, rGrow = a.rows ? b.rows / a.rows : 1;
      if (tGrow > 1.5 && rGrow < 1.2 && b.y - a.y > 25) windowed = { tGrow, rGrow, from: a.x, to: b.x };   // 25 ms: past timing noise
    }
    let status = "ok";
    if (failed) status = "error";
    else if (overJudged) status = "over";
    else if (over || windowed || (k !== null && k > 1.2)) status = "watch";
    out.push({ op, cls, series, k, failed, over, overJudged, windowed, status });
  }
  return out;
}

const growthWord = (k) => k === null ? "–" : k < 0.2 ? "flat" : k < 0.8 ? "sublinear" : k <= 1.2 ? "linear" : "faster than linear";

// A small log-log chart of one operation: median time at each step, its limit as a dashed line.
function sparkChart(a, tiers, idx) {
  const W = 320, H = 150, L = 46, R = 14, T = 12, B = 26;
  const xs = tiers.map(t => t.orders);
  const ys = a.series.flatMap(s => [s.y, s.p95]).concat(a.cls.limitMs ? [a.cls.limitMs] : []);
  if (!a.series.length) return `<div class="nochart">No timings${a.failed ? ": " + esc(a.failed.r.error) : ""}</div>`;
  const lx0 = Math.log10(Math.min(...xs)), lx1 = Math.log10(Math.max(...xs)) || lx0 + 1;
  let ly0 = Math.floor(Math.log10(Math.max(0.5, Math.min(...ys)))), ly1 = Math.ceil(Math.log10(Math.max(...ys)));
  if (ly1 === ly0) ly1 = ly0 + 1;
  const X = (v) => L + (lx1 === lx0 ? (W - L - R) / 2 : (Math.log10(v) - lx0) / (lx1 - lx0) * (W - L - R));
  const Y = (v) => T + (1 - (Math.log10(v) - ly0) / (ly1 - ly0)) * (H - T - B);
  const grid = [];
  for (let e = ly0; e <= ly1; e++) {
    const v = 10 ** e;
    grid.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="tick" x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${esc(fmtMs(v))}</text>`);
  }
  const xt = xs.map(v => `<text class="tick" x="${X(v).toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtN(v)}</text>`).join("");
  const limit = a.cls.limitMs ? `<line class="limit" x1="${L}" x2="${W - R}" y1="${Y(a.cls.limitMs).toFixed(1)}" y2="${Y(a.cls.limitMs).toFixed(1)}"/>` : "";
  const band = a.series.length > 1 ? `<path class="band" d="${a.series.map((s, i) => (i ? "L" : "M") + X(s.x).toFixed(1) + " " + Y(s.p95).toFixed(1)).join(" ")} ${[...a.series].reverse().map(s => "L" + X(s.x).toFixed(1) + " " + Y(s.y).toFixed(1)).join(" ")} Z"/>` : "";
  const line = a.series.length > 1 ? `<path class="line" d="${a.series.map((s, i) => (i ? "L" : "M") + X(s.x).toFixed(1) + " " + Y(s.y).toFixed(1)).join(" ")}"/>` : "";
  const dots = a.series.map((s, i) => {
    const tip = `${fmtN(s.x)} orders · median ${fmtMs(s.y)} · p95 ${fmtMs(s.p95)} · ${s.rows} rows · ${fmtBytes(s.bytes)}`;
    return `<circle class="dot${i === a.series.length - 1 ? " end" : ""}" cx="${X(s.x).toFixed(1)}" cy="${Y(s.y).toFixed(1)}" r="${i === a.series.length - 1 ? 4.5 : 3.5}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(a.op.title)}: median time by number of orders" id="chart-${idx}">${grid.join("")}${xt}${limit}${band}${line}${dots}</svg>`;
}

const PILL = {
  ok: ["good", "✓", "Within limit"],
  watch: ["warning", "!", "Watch"],
  over: ["critical", "✕", "Over limit"],
  error: ["critical", "✕", "Failed"],
};
const pill = (s) => `<span class="pill ${PILL[s][0]}"><span aria-hidden="true">${PILL[s][1]}</span> ${PILL[s][2]}</span>`;

function why(a) {
  const bits = [];
  if (a.failed) bits.push(`Failed at ${fmtN(a.failed.x)} orders: ${esc(a.failed.r.error)}`);
  if (a.over) bits.push(`p95 ${fmtMs(a.over.r.p95)} at ${fmtN(a.over.x)} orders, over the ${fmtMs(a.cls.limitMs)} limit${a.overJudged ? "" : ` (beyond the ${fmtN(a.cls.judgeUpTo)} orders this class is judged at)`}`);
  if (a.windowed) bits.push(`Answer stayed about the same size (×${a.windowed.rGrow.toFixed(2)}) but took ×${a.windowed.tGrow.toFixed(1)} as long from ${fmtN(a.windowed.from)} to ${fmtN(a.windowed.to)} orders: it reads more than its window`);
  if (a.k !== null && a.k > 1.2) bits.push(`Time grows faster than the history (exponent ${a.k.toFixed(2)})`);
  return bits;
}

function profileSection(profile) {
  if (!profile) return `<p class="muted">No query profile yet. Run <code>npm run perf:profile -- --data &lt;kept data folder&gt;</code> after a run with <code>--keep-data</code>.</p>`;
  return `<p class="muted">Run on a copy of the ${fmtN(profile.orders)}-order database through the real handler code on native SQLite (${esc(profile.sqlite)}). Statements are grouped by their text. "Full scan" reads a whole table; "Wide search" uses an index but still takes over 20 ms a call, which usually means the index matches most of the table.</p>` +
    profile.ops.map(p => `<section class="prof"><h3>${esc(p.title)} <span class="muted">${fmtMs(p.totalMs)} total · ${p.statements} statements</span></h3>
      <div class="scroll"><table><thead><tr><th>Statement</th><th class="num">Calls</th><th class="num">Total</th><th>Plan</th></tr></thead><tbody>
      ${p.top.map(s => `<tr><td><code>${esc(s.sql.slice(0, 220))}${s.sql.length > 220 ? "…" : ""}</code></td><td class="num">${s.calls}</td><td class="num">${fmtMs(s.ms)}</td>
        <td>${s.scans.length ? `<span class="pill critical"><span aria-hidden="true">✕</span> Full scan</span> <code>${esc(s.scans.join("; ").slice(0, 160))}</code>`
          : s.ms / s.calls > 20 ? `<span class="pill warning"><span aria-hidden="true">!</span> Wide search</span> <code>${esc((s.plan || []).filter(l => /^SEARCH/.test(l)).slice(0, 2).join("; ").slice(0, 200))}</code>`
          : `<span class="muted">${esc((s.plan || []).slice(0, 2).join("; ").slice(0, 120))}</span>`}</td></tr>`).join("")}
      </tbody></table></div></section>`).join("");
}

function writeReport(results, file, { profile = null } = {}) {
  const tiers = results.tiers;
  const A = analyse(results);
  const counts = { ok: 0, watch: 0, over: 0, error: 0 };
  for (const a of A) counts[a.status]++;
  const last = tiers[tiers.length - 1] || {};
  const flagged = A.filter(a => a.status !== "ok");
  const byClass = Object.entries(results.classes).map(([k, c]) => ({ k, c, list: A.filter(a => a.op.cls === k) })).filter(g => g.list.length);
  const progPts = (f) => tiers.filter(t => f(t) !== undefined).map(t => ({ x: t.orders, y: f(t) }));
  const programme = [
    ["Program start (opening the database)", progPts(t => t.startMs), fmtMs],
    ["Back up (copying the data folder)", progPts(t => t.backupMs), fmtMs],
    ["Database file", progPts(t => t.dbBytes), fmtBytes],
  ];
  const meta = results.meta;
  const html = `<title>Order Scale Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: a lab notebook — findings first, then one small chart per operation, grouped by what a person waits for. */
:root {
  --bg: #f7f8fa; --surface: #ffffff; --ink: #14171c; --ink-2: #4b525d; --ink-3: #6f7782; --line: #dfe3e8;
  --series: #2a78d6; --band: rgba(42,120,214,.14); --limit: #8a919b;
  --good: #0a7d0a; --warning: #8a5a00; --critical: #c03030;
  --good-bg: #e6f4e6; --warning-bg: #fdf1d6; --critical-bg: #fbe6e6;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #121417; --surface: #1a1d21; --ink: #eef0f2; --ink-2: #b9bfc7; --ink-3: #8d949e; --line: #2c3138;
  --series: #3987e5; --band: rgba(57,135,229,.2); --limit: #7d848e;
  --good: #3fc33f; --warning: #f2b233; --critical: #ef6b6b;
  --good-bg: #16301a; --warning-bg: #352a12; --critical-bg: #3a1c1c; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #121417; --surface: #1a1d21; --ink: #eef0f2; --ink-2: #b9bfc7; --ink-3: #8d949e; --line: #2c3138;
  --series: #3987e5; --band: rgba(57,135,229,.2); --limit: #7d848e;
  --good: #3fc33f; --warning: #f2b233; --critical: #ef6b6b;
  --good-bg: #16301a; --warning-bg: #352a12; --critical-bg: #3a1c1c; color-scheme: dark; }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
.wrap { max-width: 1120px; margin: 0 auto; padding-block: 28px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 28px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0; font-weight: 600; text-wrap: balance; }
h2 { font-size: 19px; margin: 0 0 4px; font-weight: 600; text-wrap: balance; }
h3 { font-size: 15px; margin: 0; font-weight: 600; }
p { margin: 0; max-width: 70ch; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--ink-3); font-weight: 400; }
.eyebrow { font: 500 12px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); }
header { display: grid; gap: 8px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--ink-2); font-size: 13px; }
.meta b { font-weight: 500; color: var(--ink); }
.totals { display: flex; flex-wrap: wrap; gap: 10px; }
.pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 9px; border-radius: 999px; font-size: 12.5px; font-weight: 500; white-space: nowrap; }
.pill.good { color: var(--good); background: var(--good-bg); }
.pill.warning { color: var(--warning); background: var(--warning-bg); }
.pill.critical { color: var(--critical); background: var(--critical-bg); }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 500; color: var(--ink-2); font-size: 12.5px; background: var(--bg); position: sticky; top: 0; }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
td.over { color: var(--critical); font-weight: 500; }
.grid-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 14px 10px; display: grid; gap: 6px; min-width: 0; align-content: start; }
.card-head { display: flex; justify-content: space-between; gap: 8px; align-items: start; }
.card-sub { font-size: 12.5px; color: var(--ink-3); font-family: var(--mono); }
.card ul { margin: 0; padding-left: 18px; font-size: 13px; color: var(--ink-2); }
svg { width: 100%; height: auto; display: block; overflow: visible; }
svg .grid { stroke: var(--line); stroke-width: 1; }
svg .tick { fill: var(--ink-3); font: 10.5px var(--mono); }
svg .limit { stroke: var(--limit); stroke-width: 1.5; stroke-dasharray: 5 4; }
svg .line { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; }
svg .band { fill: var(--band); stroke: none; }
svg .dot { fill: var(--series); stroke: var(--surface); stroke-width: 2; cursor: default; }
svg .dot:focus { outline: none; stroke: var(--ink); }
.nochart { padding: 30px 0; text-align: center; color: var(--ink-3); font-size: 13px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.5px; color: var(--ink-2); align-items: center; }
.key { display: inline-block; width: 22px; height: 0; border-top: 2px solid var(--series); vertical-align: middle; margin-right: 6px; }
.key.limit { border-top: 1.5px dashed var(--limit); }
.key.band { height: 10px; border: 0; background: var(--band); }
#tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--bg); font: 12px var(--mono); padding: 6px 9px; border-radius: 6px; max-width: 280px; z-index: 5; }
details { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
summary { cursor: pointer; font-weight: 500; }
summary:focus-visible, .dot:focus-visible { outline: 2px solid var(--series); outline-offset: 2px; }
.prof { display: grid; gap: 8px; margin-top: 16px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
<div class="wrap">
<header>
  <div class="eyebrow">OpenDecoDesk desktop · scale test</div>
  <h1>Order Scale Report</h1>
  <p>How the admin's order operations slow down as the order history grows, measured on the desktop program (the real server and its SQLite file on this computer). Each step adds orders copied from template orders the app itself made, then times every operation ${esc(meta.args && meta.args.runs)} times after a warm-up.</p>
  <div class="meta">
    <span>Commit <b class="mono">${esc(meta.commit)}</b></span>
    <span>Started <b>${esc((meta.startedAt || "").replace("T", " ").slice(0, 16))} UTC</b></span>
    <span>Steps <b>${tiers.map(t => fmtN(t.orders)).join(" → ") || "none yet"}</b></span>
    <span>Machine <b>${esc(meta.cpu)} · ${esc(meta.cpus)} cores · ${esc(meta.memGB)} GB</b></span>
    <span>Node <b>${esc(meta.node)}</b></span>
    ${meta.finishedAt ? "" : `<span><b>Still running</b> (this page is rewritten after each step)</span>`}
  </div>
  <div class="totals">${counts.ok ? pill("ok") + `<span class="muted">${counts.ok}</span>` : ""} ${counts.watch ? pill("watch") + `<span class="muted">${counts.watch}</span>` : ""} ${counts.over ? pill("over") + `<span class="muted">${counts.over}</span>` : ""} ${counts.error ? pill("error") + `<span class="muted">${counts.error}</span>` : ""}</div>
</header>

<section>
  <h2>Findings</h2>
  <p class="muted" style="margin-bottom:10px">Limits: screens and single changes p95 ≤ 1 s up to 25k orders; bulk changes ≤ 10 s; reports ≤ 5 s up to 100k orders. "Watch" means over a limit only beyond the judged size, growing faster than the history, or a fixed window that slows down anyway.</p>
  ${flagged.length ? `<div class="scroll"><table><thead><tr><th>Operation</th><th>Status</th><th>Why</th></tr></thead><tbody>
  ${flagged.sort((x, y) => ["error", "over", "watch"].indexOf(x.status) - ["error", "over", "watch"].indexOf(y.status)).map(a => `<tr><td>${esc(a.op.title)}<div class="card-sub">${esc(a.op.name)}</div></td><td>${pill(a.status)}</td><td>${why(a).join("<br>")}</td></tr>`).join("")}
  </tbody></table></div>` : `<p>Nothing over its limit${tiers.length ? " up to " + fmtN(last.orders) + " orders" : ""}.</p>`}
</section>

${byClass.map(g => `<section>
  <h2>${esc(g.c.label)}</h2>
  <div class="legend" style="margin-bottom:10px"><span><span class="key"></span>median</span><span><span class="key band"></span>median to p95</span>${g.c.limitMs ? `<span><span class="key limit"></span>limit ${fmtMs(g.c.limitMs)}</span>` : ""}<span class="muted">Both axes are logarithmic. Hover or focus a point for its numbers.</span></div>
  <div class="grid-cards">${g.list.map((a) => `<article class="card">
    <div class="card-head"><h3>${esc(a.op.title)}</h3>${pill(a.status)}</div>
    <div class="card-sub">${esc(a.op.name)}${a.op.windowed ? " · fixed window" : ""} · growth ${a.k === null ? "–" : a.k.toFixed(2) + " (" + growthWord(a.k) + ")"}</div>
    ${sparkChart(a, tiers, A.indexOf(a))}
    ${why(a).length ? `<ul>${why(a).map(w => `<li>${w}</li>`).join("")}</ul>` : ""}
  </article>`).join("")}</div>
</section>`).join("\n")}

<section>
  <h2>The program and its data</h2>
  <div class="grid-cards" style="margin-top:10px">${programme.map(([title, pts, f]) => `<article class="card"><h3>${esc(title)}</h3>
    <div class="card-sub">${pts.map(p => fmtN(p.x) + ": " + f(p.y)).join(" · ") || "–"}</div></article>`).join("")}</div>
</section>

<section>
  <h2>All timings</h2>
  <p class="muted" style="margin-bottom:10px">Median (p95) for each operation at each step. Red: p95 over the class limit.</p>
  <div class="scroll"><table><thead><tr><th>Operation</th>${tiers.map(t => `<th class="num">${fmtN(t.orders)}</th>`).join("")}</tr></thead><tbody>
  ${A.map(a => `<tr><td>${esc(a.op.title)}</td>${tiers.map(t => { const r = t.ops[a.op.name]; if (!r) return `<td class="num">–</td>`;
    if (r.skipped) return `<td class="num muted">skipped</td>`; if (r.error) return `<td class="num over">failed</td>`;
    return `<td class="num${a.cls.limitMs && r.p95 > a.cls.limitMs ? " over" : ""}">${fmtMs(r.median)}<br><span class="muted">${fmtMs(r.p95)}</span></td>`; }).join("")}</tr>`).join("")}
  </tbody></table></div>
</section>

<section>
  <h2>Where the time goes</h2>
  ${profileSection(profile)}
</section>

<details>
  <summary>Data at each step (rows per table, checks, memory)</summary>
  <div class="scroll" style="margin-top:10px"><table><thead><tr><th>Step</th><th class="num">Orders</th><th class="num">Lines</th><th class="num">Payments</th><th class="num">Audit</th><th class="num">Products</th><th class="num">Copy in</th><th>Checks</th><th class="num">workerd peak</th></tr></thead><tbody>
  ${tiers.map(t => `<tr><td class="num">${fmtN(t.orders)}</td><td class="num">${(t.rowCounts.orders || 0).toLocaleString()}</td><td class="num">${(t.rowCounts.order_items || 0).toLocaleString()}</td><td class="num">${(t.rowCounts.order_payments || 0).toLocaleString()}</td><td class="num">${(t.rowCounts.audit_log || 0).toLocaleString()}</td><td class="num">${(t.rowCounts.products || 0).toLocaleString()}</td><td class="num">${fmtMs(t.cloneMs)}</td>
    <td>${t.checks.quickCheck === "ok" && !t.checks.foreignKeyProblems && (t.checks.shape || []).every(s => s.ok) ? pill("ok") : `<span class="pill critical">✕ ${esc(t.checks.quickCheck)} · ${t.checks.foreignKeyProblems} key problems · shape ${(t.checks.shape || []).filter(s => s.ok).length}/${(t.checks.shape || []).length}</span>`}</td>
    <td class="num">${t.memoryReads ? t.memoryReads.workerdMB + " MB" : "–"}</td></tr>`).join("")}
  </tbody></table></div>
  <p class="muted" style="margin-top:10px">Templates: ${results.templates ? results.templates.orders + " orders (" + Object.entries(results.templates.kinds).map(([k, n]) => k + " " + n).join(", ") + ")" : "–"}. Orders arrive at ${esc(meta.args && meta.args.perDay)} a day across three shops; each step extends the history further back, so the last 30 days and the open orders stay about the same size.</p>
</details>
</div>
<div id="tip" hidden></div>
<script>
(function () {
  var tip = document.getElementById("tip");
  function show(e) {
    var t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.getAttribute("data-tip");
    tip.hidden = false;
    var r = t.getBoundingClientRect();
    var x = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2));
    var y = r.top - tip.offsetHeight - 8; if (y < 8) y = r.bottom + 8;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  document.addEventListener("mouseover", show);
  document.addEventListener("focusin", show);
  document.addEventListener("mouseout", function (e) { if (e.target.closest && e.target.closest("[data-tip]")) tip.hidden = true; });
  document.addEventListener("focusout", function () { tip.hidden = true; });
  window.addEventListener("scroll", function () { tip.hidden = true; }, { passive: true });
})();
</script>
`;
  fs.writeFileSync(file, html);
}

// For the terminal: one line per operation, median at each step.
function summaryTable(results) {
  const A = analyse(results);
  const tiers = results.tiers.map(t => t.orders);
  const head = "operation".padEnd(26) + tiers.map(t => fmtN(t).padStart(10)).join("") + "  growth  status";
  const rows = A.map(a => a.op.name.padEnd(26) + results.tiers.map(t => {
    const r = t.ops[a.op.name];
    return (!r ? "–" : r.skipped ? "skip" : r.error ? "FAIL" : fmtMs(r.median)).padStart(10);
  }).join("") + "  " + (a.k === null ? "–" : a.k.toFixed(2)).padStart(6) + "  " + a.status);
  return [head, ...rows].join("\n");
}

// For --compare: this run's median over the earlier run's, at every step both have.
function compareTable(now, before) {
  const tiers = now.tiers.map(t => t.orders).filter(o => before.tiers.some(b => b.orders === o));
  const lines = ["Compared with " + before.meta.run + " (this run ÷ that run; below 1 is faster)", "operation".padEnd(26) + tiers.map(t => fmtN(t).padStart(10)).join("")];
  for (const op of now.ops) {
    lines.push(op.name.padEnd(26) + tiers.map(o => {
      const a = (now.tiers.find(t => t.orders === o).ops || {})[op.name], b = (before.tiers.find(t => t.orders === o).ops || {})[op.name];
      return (a && b && a.median && b.median ? "×" + (a.median / b.median).toFixed(2) : "–").padStart(10);
    }).join(""));
  }
  return lines.join("\n");
}

module.exports = { writeReport, summaryTable, compareTable, analyse, growth };
