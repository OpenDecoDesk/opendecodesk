const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// The Run times report on a long history (2026-11, review round 2). production_runs gets a row for every hooping, and
// the report read the range four times with no index on startedAt and sent every run in it as its run log, drawn as one
// table. Now (migrations/0110) the range is read on idx_runs_started; the run log is the newest 500 runs, with Load older
// fetching the next 500 after the last one shown ({startedAt, id}, as the audit log pages); and the per-design totals and
// the "Other" notes are worked out by the database over the WHOLE range — the same figures as adding up every run.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { getRunReportByDesign, cleanRunIssues };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + require("./testlib/roles").adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('prime','prime','Example League','t','t',1);
    INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('R-1','prime','Pat Example','pat@example.test','2026-01-01T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPriceCents, lineTotalCents) VALUES ('R-1','prime','tee','Tee','shirt','M',1,1000,1000);`);
  // 1,234 runs over 2026: four designs (one with no design, one renamed part-way), three machines (one unassigned),
  // aborted and untimed ones, issues of several kinds, a few "Other" notes (two on old runs, far past the first page),
  // stitch counts missing on some, and runs started in the same millisecond (the page boundary must not skip or repeat).
  const N = 1234, base = Date.parse("2026-01-05T08:00:00.000Z");
  const issueSets = ["{}", "{}", "{}", '{"threadBreak":2}', '{"bobbinOut":1,"other":1}', '{"birdsNest":1}', '{"needleBreak":3,"needleReplaced":1}'];
  for (let i = 1; i <= N; i++) {
    const at = base + Math.floor(i / 3) * 3600000;   // three runs to an hour, the same start time each
    const design = i % 4 === 0 ? null : (i % 4);
    const name = design == null ? "" : design === 2 && i > 600 ? "Crest (new)" : "Design " + design;
    const status = i % 13 === 0 ? "aborted" : "done", timed = i % 17 === 0 ? 0 : 1;
    const fin = status === "done" ? new Date(at + ((i % 7) + 1) * 61123).toISOString() : new Date(at + 5000).toISOString();
    const issues = status === "done" ? issueSets[i % issueSets.length] : "{}";
    const note = status === "done" && (i === 7 || i === 412 || i === 1201) ? "Note on run " + i : "";
    d1._raw.run(`INSERT INTO production_runs (orgId, orderId, itemId, machineName, designId, designName, startedAt, finishedAt, status, createdAt, timed, issuesJson, issueNote, stitchCount)
      VALUES ('prime','R-1',1,?,?,?,?,?,?,?,?,?,?,?)`, [["Machine 1", "Machine 2", ""][i % 3], design, name, new Date(at).toISOString(), fin, status, "t", timed,
      note ? JSON.stringify(Object.assign(JSON.parse(issues), { other: 2 })) : issues, note, i % 5 === 0 ? null : 1000 + i]);
  }
  const all = d1.q("SELECT * FROM production_runs ORDER BY id");

  // The totals, added up run by run the way the report always worked them out.
  const issuesOf = (r) => lib.cleanRunIssues(JSON.parse(r.issuesJson || "{}"), "").issues;
  const expected = () => {
    const byDesign = new Map(), totals = {}; let withIssues = 0, done = 0;
    const acc = () => ({ runs: 0, totalMs: 0, issues: {}, runsWithIssues: 0, stitches: 0, stitchRuns: 0, stitchMs: 0 });
    const ensure = (r) => { const k = r.designId == null ? "none" : String(r.designId);
      if (!byDesign.has(k)) byDesign.set(k, Object.assign(acc(), { designName: r.designName || "(no design)", abortedCount: 0, m: new Map() })); return byDesign.get(k); };
    const add = (into, r, ms, issues) => { into.runs++; into.totalMs += ms; if (r.stitchCount != null) { into.stitches += r.stitchCount; into.stitchRuns++; into.stitchMs += ms; }
      if (Object.keys(issues).length) { into.runsWithIssues++; for (const k in issues) into.issues[k] = (into.issues[k] || 0) + issues[k]; } };
    for (const r of all) {
      if (r.status === "aborted") continue;
      if (r.status !== "done" || !r.finishedAt || r.timed === 0) continue;
      const g = ensure(r), ms = Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt)), mk = r.machineName || "(unassigned)", iss = issuesOf(r);
      if (!g.m.has(mk)) g.m.set(mk, acc());
      add(g, r, ms, iss); add(g.m.get(mk), r, ms, iss); done++;
      if (Object.keys(iss).length) { withIssues++; for (const k in iss) totals[k] = (totals[k] || 0) + iss[k]; }
    }
    for (const r of all) if (r.status === "aborted") ensure(r).abortedCount++;
    const out = (a) => ({ runs: a.runs, totalMs: a.totalMs, issues: a.issues, runsWithIssues: a.runsWithIssues, stitches: a.stitches, stitchRuns: a.stitchRuns, stitchMs: a.stitchMs });
    return { done, withIssues, totals, designs: [...byDesign.values()].map(g => ({ name: g.designName, aborted: g.abortedCount, ...out(g),
      machines: [...g.m].map(([name, m]) => ({ name, ...out(m) })) })) };
  };
  const want = expected();

  // Every query the report makes.
  const log = [];
  const spy = { prepare: (sql) => { const e = { sql, args: [] }; log.push(e); const st = d1.prepare(sql); const w = (s) => ({ bind: (...a) => { e.args = a; return w(s.bind(...a)); }, all: () => s.all(), first: (c) => s.first(c) }); return w(st); } };
  const rep = await lib.getRunReportByDesign(spy, { from: "2026-01-01", to: "2026-12-31" });

  console.log("=== The totals cover the whole range ===");
  const norm = (o) => JSON.stringify(o, Object.keys(o).sort());
  const sameIssues = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  ok(`finished runs, runs with issues and the issue totals: ${want.done} runs`, rep.doneRuns === want.done && rep.runsWithIssues === want.withIssues && sameIssues(rep.issueTotals, want.totals));
  const designOk = want.designs.every(w => { const d = rep.designs.find(x => x.designName === w.name);
    return d && d.runs === w.runs && d.totalMs === w.totalMs && d.abortedCount === w.aborted && sameIssues(d.issues, w.issues) && d.runsWithIssues === w.runsWithIssues &&
      d.stitches === w.stitches && d.runsNoStitches === w.runs - w.stitchRuns && d.avgMs === Math.round(w.totalMs / w.runs) &&
      d.stitchesPerMin === Math.round(w.stitches / (w.stitchMs / 60000)) && d.byMachine.length === w.machines.length &&
      w.machines.every(m => { const x = d.byMachine.find(y => y.machineName === m.name); return x && x.runs === m.runs && x.totalMs === m.totalMs && sameIssues(x.issues, m.issues) &&
        x.runsWithIssues === m.runsWithIssues && x.stitches === m.stitches && x.runsNoStitches === m.runs - m.stitchRuns; }); });
  ok("each design and each of its machines: runs, time to the millisecond, aborted, issues and stitches, as adding up every run", rep.designs.length === want.designs.length && designOk);
  ok("…a renamed design keeps the name of its first run, as before", rep.designs.some(d => d.designName === "Design 2") && !rep.designs.some(d => d.designName === "Crest (new)"));
  const notes = all.filter(r => r.status === "done" && r.timed !== 0 && r.issueNote).sort((a, b) => b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : b.id - a.id);
  ok("the Other notes come from the whole range, newest first — including runs long past the first page of the log",
    rep.otherNotes.length === 3 && rep.otherNotes.map(n => n.runId).join() === notes.map(n => n.id).join() && rep.otherNotes.every(n => n.count === 2 && /^Note on run \d+$/.test(n.note)) &&
    rep.otherNotes.some(n => !rep.detail.some(x => x.runId === n.runId)));

  console.log("\n=== The run log comes a page at a time ===");
  const timed = all.filter(r => r.timed !== 0).sort((a, b) => b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : b.id - a.id);
  ok(`the newest 500 of the ${timed.length} timed runs, newest first, saying there are more`, rep.detail.length === 500 && rep.detailMore === true &&
    rep.detail.map(x => x.runId).join() === timed.slice(0, 500).map(r => r.id).join());
  const pages = [rep.detail];
  let more = rep.detailMore, guard = 0;
  while (more && guard++ < 10) {
    const last = pages[pages.length - 1].slice(-1)[0];
    const next = await lib.getRunReportByDesign(d1, { from: "2026-01-01", to: "2026-12-31", before: { startedAt: last.startedAt, id: last.runId } });
    ok(`page ${pages.length + 1}: only the log, no totals worked out again`, Array.isArray(next.detail) && next.designs === undefined && next.otherNotes === undefined);
    pages.push(next.detail); more = next.detailMore;
  }
  const ids = pages.flat().map(x => x.runId);
  ok("Load older's pages give every timed run once, in order — runs started in the same millisecond neither skipped nor repeated",
    pages.length === Math.ceil(timed.length / 500) && ids.join() === timed.map(r => r.id).join() && new Set(ids).size === ids.length);

  console.log("\n=== Each query reads the range on idx_runs_started ===");
  const reportQueries = log.filter(e => /FROM production_runs/.test(e.sql));
  const plans = reportQueries.map(e => d1.q("EXPLAIN QUERY PLAN " + e.sql, ...e.args).map(r => String(r.detail)).filter(t => /^(SEARCH|SCAN) (pr|production_runs)\b/.test(t)));
  ok(`all ${reportQueries.length} of the report's queries (log, totals, aborted, notes, untimed) search the start-time index`, reportQueries.length === 5 &&
    plans.every(p => p.length === 1 && /USING (COVERING )?INDEX idx_runs_started \(startedAt>\? AND startedAt<\?\)/.test(p[0])) || (console.log("   ", plans), false));
  const schema = read("schema.sql"), mig = read("migrations/0110_growth_indexes.sql");
  ok("migration 0110 and schema.sql both create it", [schema, mig].every(s => /CREATE INDEX IF NOT EXISTS idx_runs_started ON production_runs\(startedAt\);/.test(s)));

  console.log("\n=== The screen: Load older ===");
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const r = await call(b); return { ok: r.status < 400, status: r.status, json: async () => r.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, doc = w.document, q = (s) => doc.querySelector(s);
  const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); return !!fn(); };
  await new Promise(r => setTimeout(r, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie";`);
  w.eval(`renderRunReport(document.getElementById("app"))`);
  await until(() => q("#rrRunLog"));
  q("#rrFrom").value = "2026-01-01"; q("#rrTo").value = "2026-12-31";
  q("#rrFilters").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => q("#rrRunLog") && q("#rrRunLog tbody").children.length === 500 && q("#rrLoadOlder"));
  const rowsNow = () => q("#rrRunLog tbody").children.length;
  ok("the log shows the newest 500 runs, and says so with a Load older button", rowsNow() === 500 && /Showing the newest 500 runs/.test(q("#rrRunLogFooter").textContent) && !!q("#rrLoadOlder"));
  // Changing the dates without Generate doesn't change what Load older continues.
  q("#rrFrom").value = "2026-06-01";
  q("#rrLoadOlder").click();
  await until(() => rowsNow() === 1000);
  const asked = sent[sent.length - 1];
  ok("Load older adds the next 500 under them, asking for the runs before the last one shown, in the same range", rowsNow() === 1000 &&
    asked.action === "getRunReportByDesign" && asked.from === "2026-01-01" && asked.before && asked.before.id === pages[0][499].runId && asked.before.startedAt === pages[0][499].startedAt);
  q("#rrLoadOlder").click();
  await until(() => rowsNow() === timed.length);
  ok("…until every run is shown: then the count, and no button", rowsNow() === timed.length && !q("#rrLoadOlder") && q("#rrRunLogFooter").textContent.trim() === `${timed.length} runs`);
  ok("…and the Other notes and totals were drawn once, from the whole range", doc.querySelectorAll("#rrOtherNotes tbody tr").length === 3);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test322 crashed: false"); process.exit(1); });
