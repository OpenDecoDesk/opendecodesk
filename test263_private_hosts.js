const fs = require("fs");
const http = require("http");

// Vendor image links never reach a private address (code review #77). copyVendorImage (functions/_lib/vendorImages.js)
// fetches a link an admin pastes or a vendor's file lists; it refused only some private addresses (no 172.16/12,
// 100.64/10, 198.18/15, IPv6) and let fetch follow redirects, so a public host could send the request on to one.
// Now privateHost_ covers this machine, the private and reserved blocks and IPv6 literals, and redirects are
// followed here one hop at a time (at most 3), each new address checked like the first. On the desktop, the
// Worker's fetch() is limited to public addresses (desktop/server.js WORKER_OUTBOUND), which also catches a name
// that resolves to a private address: checked in a real Miniflare against a server on this computer.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const vi = new Function(strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) +
  "\nreturn { copyVendorImage, privateHost: typeof privateHost_ === 'function' ? privateHost_ : null };")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082", "hex");
const imgRes = () => new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
const redirect = (to, status = 302) => new Response(null, { status, headers: { Location: to } });

(async () => {
  const stored = [];
  const env = { IMAGES: { put: async (k) => { stored.push(k); } }, R2_PUBLIC_BASE: "https://images.example.test" };
  // A fetch that records every address asked for and answers from a table (anything else: the image).
  const fetchFrom = (table) => { const seen = []; const f = async (url, init) => { seen.push({ url, redirect: init && init.redirect }); return table[url] ? table[url]() : imgRes(); }; f.seen = seen; return f; };

  console.log("=== Addresses written in the link ===");
  const refused = ["https://172.16.0.1/a.png", "https://172.31.255.254/a.png", "https://100.64.0.1/a.png", "https://198.18.0.1/a.png", "https://198.19.1.1/a.png",
    "https://224.0.0.1/a.png", "https://240.0.0.1/a.png", "https://255.255.255.255/a.png", "https://192.0.2.1/a.png", "https://0.0.0.0/a.png",
    "https://127.0.0.1/a.png", "https://2130706433/a.png", "https://0x7f.1/a.png", "https://10.1.2.3/a.png", "https://169.254.169.254/a.png", "https://192.168.1.1/a.png",
    "https://[::1]/a.png", "https://[::]/a.png", "https://[fc00::1]/a.png", "https://[fd12:3456::1]/a.png", "https://[fe80::1]/a.png", "https://[ff02::1]/a.png",
    "https://[::ffff:127.0.0.1]/a.png", "https://[::ffff:10.0.0.1]/a.png", "https://[::ffff:a9fe:a9fe]/a.png",
    "https://localhost/a.png", "https://LOCALHOST./a.png", "https://shop.localhost/a.png", "https://intranet/a.png"];
  const missed = [];
  for (const url of refused) {
    const f = fetchFrom({});
    const out = await vi.copyVendorImage(env, url, f);
    if (out.ok || f.seen.length) missed.push(url);
  }
  ok("every private, reserved, loopback or local-name address is refused before any request (172.16/12, 100.64/10, 198.18/15, multicast, IPv6, ::ffff-mapped…)", missed.length === 0);
  if (missed.length) console.log("  let through:", missed.join(" "));
  for (const url of ["https://cdn.example.test/a.png", "https://203.0.114.9/a.png", "https://[2606:4700::1]/a.png", "https://[::ffff:8.8.8.8]/a.png"]) {
    const out = await vi.copyVendorImage(env, url, fetchFrom({}));
    ok("a public address is fetched: " + url, out.ok);
  }

  console.log("\n=== privateHost_ on its own ===");
  const ph = vi.privateHost;
  ok("privateHost_ is there", typeof ph === "function");
  if (ph) {
    ok("the edges of 172.16/12, 100.64/10 and 198.18/15", ph("172.16.0.0") && ph("172.31.255.255") && !ph("172.32.0.1") && !ph("172.15.255.255") &&
      ph("100.127.255.255") && !ph("100.128.0.1") && !ph("100.63.255.255") && ph("198.19.255.255") && !ph("198.20.0.1") && !ph("198.17.255.255"));
    ok("IPv6: NAT64 of a private address, documentation and site-local refused; a public one allowed", ph("[64:ff9b::a00:1]") && ph("[2001:db8::1]") && ph("[fec0::1]") && !ph("[2001:4860::8888]") && !ph("[64:ff9b::808:808]"));
    ok("something that isn't a readable address is refused", ph("") && ph("[1::2::3]") && ph("[zz::1]") && ph("1.2.3"));
  }

  console.log("\n=== Redirects: followed here, each hop checked ===");
  let f = fetchFrom({ "https://cdn.example.test/a.png": () => redirect("https://img.example.test/b.png") });
  let out = await vi.copyVendorImage(env, "https://cdn.example.test/a.png", f);
  ok("a redirect to another public host is followed", out.ok && f.seen.map(s => s.url).join() === "https://cdn.example.test/a.png,https://img.example.test/b.png");
  ok("…and fetch is asked not to follow redirects itself", f.seen.every(s => s.redirect === "manual"));
  f = fetchFrom({ "https://cdn.example.test/a.png": () => redirect("/c.png", 301) });
  out = await vi.copyVendorImage(env, "https://cdn.example.test/a.png", f);
  ok("a relative redirect is read against the address it came from", out.ok && f.seen[1].url === "https://cdn.example.test/c.png");
  for (const to of ["https://192.168.0.10/a.png", "https://[::1]/a.png", "https://localhost/a.png", "http://img.example.test/a.png", "https://172.20.0.5/a.png"]) {
    f = fetchFrom({ "https://cdn.example.test/a.png": () => redirect(to) });
    out = await vi.copyVendorImage(env, "https://cdn.example.test/a.png", f);
    ok("a redirect to " + to + " is refused, never fetched", !out.ok && f.seen.length === 1);
  }
  f = fetchFrom({ "https://cdn.example.test/1": () => redirect("/2"), "https://cdn.example.test/2": () => redirect("/3"), "https://cdn.example.test/3": () => redirect("/4"),
    "https://cdn.example.test/4": () => redirect("/5") });
  out = await vi.copyVendorImage(env, "https://cdn.example.test/1", f);
  ok("a fourth redirect is one too many", !out.ok && /redirects too many/.test(out.message) && f.seen.length === 4);
  f = fetchFrom({ "https://cdn.example.test/1": () => redirect("/2"), "https://cdn.example.test/2": () => redirect("/3"), "https://cdn.example.test/3": () => redirect("/4") });
  out = await vi.copyVendorImage(env, "https://cdn.example.test/1", f);
  ok("three are followed", out.ok && f.seen.length === 4);
  f = fetchFrom({ "https://cdn.example.test/a.png": () => new Response(null, { status: 304 }) });
  out = await vi.copyVendorImage(env, "https://cdn.example.test/a.png", f);
  ok("a 3xx with no Location is an answer, not a redirect", !out.ok && /answered 304/.test(out.message));

  console.log("\n=== The desktop Worker's fetch() reaches the public internet only (Miniflare) ===");
  const server = require("./desktop/server.js");
  const src = read("desktop/server.js");
  const appWorker = src.slice(src.indexOf('name: "app"'), src.indexOf('name: "files"'));
  ok("the program's Worker is given the outbound rule", /outboundService: WORKER_OUTBOUND/.test(appWorker) && !!server.WORKER_OUTBOUND);
  ok("…public addresses only, the same network service as Miniflare's default otherwise", JSON.stringify(server.WORKER_OUTBOUND.network.allow) === '["public"]' &&
    server.WORKER_OUTBOUND.network.tlsOptions.trustBrowserCas === true && server.WORKER_OUTBOUND.network.deny.includes("100.64.0.0/10"));
  const local = http.createServer((q, r) => r.end("local answer")).listen(0, "127.0.0.1");
  await new Promise(r => local.once("listening", r));
  const port = local.address().port;
  const { Miniflare } = require("miniflare");
  const script = `export default { async fetch(req) { const u = new URL(req.url).searchParams.get("u");
    try { const r = await fetch(u); return new Response("answered " + (await r.text())); } catch (e) { return new Response("refused"); } } }`;
  const tryFetch = async (outbound, u) => {
    const mf = new Miniflare({ modules: true, script, compatibilityDate: "2025-09-01", ...(outbound ? { outboundService: outbound } : {}),
      handleRuntimeStdio: (o, e) => { o.resume(); e.resume(); } });
    try { return await (await mf.dispatchFetch("http://app.example.test/?u=" + encodeURIComponent(u))).text(); }
    finally { await mf.dispose(); }
  };
  ok("(control) without the rule, the Worker reaches a server on this computer", await tryFetch(null, "http://127.0.0.1:" + port + "/") === "answered local answer");
  ok("with it, 127.0.0.1 is refused", await tryFetch(server.WORKER_OUTBOUND, "http://127.0.0.1:" + port + "/") === "refused");
  ok("…and so is a name that resolves to this computer (localhost)", await tryFetch(server.WORKER_OUTBOUND, "http://localhost:" + port + "/") === "refused");
  local.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
