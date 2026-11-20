// Stitch-file readers for Designs (admin.js loads this file on demand, the first time it reads a machine file
// that isn't a Tajima .dst or Barudan .dsb — those two are read in admin.js itself).
//
// The record layouts and the makers' color charts are ported from pyembroidery
// (https://github.com/EmbroidePy/pyembroidery), MIT license — see NOTICE.
//
// Every reader returns the shape admin.js's parseDst_ returns:
//   { stitches: [{x, y, jump, color}], needleStops, colorChanges, stitchCount, bbox, fileColors, needles }
// x/y are in the file's own units with Y pointing up (the preview flips it). `color` is the NEEDLE STOP: a block
// counts only once it stitches, so a color change with no stitches after it doesn't add a stop (the rule the
// .dst/.dsb readers follow). `fileColors[i]` is what the file says stop i's thread is —
// { hex, brand, code, name, chart } with any part possibly "" — or null when the file says nothing.
(function () {
  "use strict";

  // ---- Makers' color charts: [hex, name, code]. A file stores a position in one of these, not the color. ----
  // Brother (PEC block of .pes / .pec / .phb / .phc). Position 0 is unused. The numbers are chart positions,
  // not the maker's thread numbers, so these match by name and color.
  const PEC_CHART = [null, ["0e1f7c", "Prussian Blue"], ["0a55a3", "Blue"], ["008777", "Teal Green"], ["4b6baf", "Cornflower Blue"], ["ed171f", "Red"], ["d15c00", "Reddish Brown"], ["913697", "Magenta"], ["e49acb", "Light Lilac"], ["915fac", "Lilac"], ["9ed67d", "Mint Green"], ["e8a900", "Deep Gold"], ["feba35", "Orange"], ["ffff00", "Yellow"], ["70bc1f", "Lime Green"], ["ba9800", "Brass"], ["a8a8a8", "Silver"], ["7d6f00", "Russet Brown"], ["ffffb3", "Cream Brown"], ["4f5556", "Pewter"], ["000000", "Black"], ["0b3d91", "Ultramarine"], ["770176", "Royal Purple"], ["293133", "Dark Gray"], ["2a1301", "Dark Brown"], ["f64a8a", "Deep Rose"], ["b27624", "Light Brown"], ["fcbbc5", "Salmon Pink"], ["fe370f", "Vermilion"], ["f0f0f0", "White"], ["6a1c8a", "Violet"], ["a8ddc4", "Seacrest"], ["2584bb", "Sky Blue"], ["feb343", "Pumpkin"], ["fff36b", "Cream Yellow"], ["d0a660", "Khaki"], ["d15400", "Clay Brown"], ["66ba49", "Leaf Green"], ["134a46", "Peacock Blue"], ["878787", "Gray"], ["d8ccc6", "Warm Gray"], ["435607", "Dark Olive"], ["fdd9de", "Flesh Pink"], ["f993bc", "Pink"], ["003822", "Deep Green"], ["b2afd4", "Lavender"], ["686ab0", "Wisteria Violet"], ["efe3b9", "Beige"], ["f73866", "Carmine"], ["b54b64", "Amber Red"], ["132b1a", "Olive Green"], ["c70156", "Dark Fuchsia"], ["fe9e32", "Tangerine"], ["a8deeb", "Light Blue"], ["00673e", "Emerald Green"], ["4e2990", "Purple"], ["2f7e20", "Moss Green"], ["ffcccc", "Flesh Pink"], ["ffd911", "Harvest Gold"], ["095ba6", "Electric Blue"], ["f0f970", "Lemon Yellow"], ["e3f35b", "Fresh Green"], ["ff9900", "Orange"], ["fff08d", "Cream Yellow"], ["ffc8c8", "Applique"]];
  // Janome (.jef). The codes are the maker's thread numbers. Position 0 means "stop", not a color.
  const JEF_CHART = [null, ["000000", "Black", "002"], ["ffffff", "White", "001"], ["ffff17", "Yellow", "204"], ["ff6600", "Orange", "203"], ["2f5933", "Olive Green", "219"], ["237336", "Green", "226"], ["65c2c8", "Sky", "217"], ["ab5a96", "Purple", "208"], ["f669a0", "Pink", "201"], ["ff0000", "Red", "225"], ["b1704e", "Brown", "214"], ["0b2f84", "Blue", "207"], ["e4c35d", "Gold", "003"], ["481a05", "Dark Brown", "205"], ["ac9cc7", "Pale Violet", "209"], ["fcf294", "Pale Yellow", "210"], ["f999b7", "Pale Pink", "211"], ["fab381", "Peach", "212"], ["c9a480", "Beige", "213"], ["970533", "Wine Red", "215"], ["a0b8cc", "Pale Sky", "216"], ["7fc21c", "Yellow Green", "218"], ["e5e5e5", "Silver Gray", "220"], ["889b9b", "Gray", "221"], ["98d6bd", "Pale Aqua", "227"], ["b2e1e3", "Baby Blue", "228"], ["368ba0", "Powder Blue", "229"], ["4f83ab", "Bright Blue", "230"], ["386a91", "Slate Blue", "231"], ["071650", "Navy Blue", "232"], ["f999a2", "Salmon Pink", "233"], ["f9676b", "Coral", "234"], ["e3311f", "Burnt Orange", "235"], ["e2a188", "Cinnamon", "236"], ["b59474", "Umber", "237"], ["e4cf99", "Blond", "238"], ["ffcb00", "Sunflower", "239"], ["e1add4", "Orchid Pink", "240"], ["c3007e", "Peony Purple", "241"], ["80004b", "Burgundy", "242"], ["540571", "Royal Purple", "243"], ["b10525", "Cardinal Red", "244"], ["cae0c0", "Opal Green", "245"], ["899856", "Moss Green", "246"], ["5c941a", "Meadow Green", "247"], ["003114", "Dark Green", "248"], ["5dae94", "Aquamarine", "249"], ["4cbf8f", "Emerald Green", "250"], ["007772", "Peacock Green", "251"], ["595b61", "Dark Gray", "252"], ["fffff2", "Ivory White", "253"], ["b15818", "Hazel", "254"], ["cb8a07", "Toast", "255"], ["986c80", "Salmon", "256"], ["98692d", "Cocoa Brown", "257"], ["4d3419", "Sienna", "258"], ["4c330b", "Sepia", "259"], ["33200a", "Dark Sepia", "260"], ["523a97", "Violet Blue", "261"], ["0d217e", "Blue Ink", "262"], ["1e77ac", "Sola Blue", "263"], ["b2dd53", "Green Dust", "264"], ["f33689", "Crimson", "265"], ["de649e", "Floral Pink", "266"], ["984161", "Wine", "267"], ["4c5612", "Olive Drab", "268"], ["4c881f", "Meadow", "269"], ["e4de79", "Mustard", "270"], ["cb8a1a", "Yellow Ocher", "271"], ["cba21c", "Old Gold", "272"], ["ff9805", "Honey Dew", "273"], ["fcb257", "Tangerine", "274"], ["ffe505", "Canary Yellow", "275"], ["f0331f", "Vermilion", "202"], ["1a842d", "Bright Green", "206"], ["386cae", "Ocean Blue", "222"], ["e3c4b4", "Beige Gray", "223"], ["e3ac81", "Bamboo", "224"]];
  // Janome, older .sew files (chart positions; matched by name and color).
  const SEW_CHART = [["000000", "Unknown"], ["000000", "Black"], ["ffffff", "White"], ["ffff17", "Sunflower"], ["faa060", "Hazel"], ["5c7649", "Green Dust"], ["40c030", "Green"], ["65c2c8", "Sky"], ["ac80be", "Purple"], ["f5bccb", "Pink"], ["ff0000", "Red"], ["c08000", "Brown"], ["0000f0", "Blue"], ["e4c35d", "Gold"], ["a52a2a", "Dark Brown"], ["d5b0d4", "Pale Violet"], ["fcf294", "Pale Yellow"], ["f0d0c0", "Pale Pink"], ["ffc000", "Peach"], ["c9a480", "Beige"], ["9b3d4b", "Wine Red"], ["a0b8cc", "Pale Sky"], ["7fc21c", "Yellow Green"], ["b9b9b9", "Silver Grey"], ["a0a0a0", "Grey"], ["98d6bd", "Pale Aqua"], ["b8f0f0", "Baby Blue"], ["368ba0", "Powder Blue"], ["4f83ab", "Bright Blue"], ["386a91", "Slate Blue"], ["00206b", "Nave Blue"], ["e5c5ca", "Salmon Pink"], ["f9676b", "Coral"], ["e3311f", "Burnt Orange"], ["e2a188", "Cinnamon"], ["b59474", "Umber"], ["e4cf99", "Blonde"], ["e1cb00", "Sunflower"], ["e1add4", "Orchid Pink"], ["c3007e", "Peony Purple"], ["80004b", "Burgundy"], ["a060b0", "Royal Purple"], ["c04020", "Cardinal Red"], ["cae0c0", "Opal Green"], ["899856", "Moss Green"], ["00aa00", "Meadow Green"], ["218a21", "Dark Green"], ["5dae94", "Aquamarine"], ["4cbf8f", "Emerald Green"], ["007772", "Peacock Green"], ["707070", "Dark Grey"], ["f2ffff", "Ivory White"], ["b15818", "Hazel"], ["cb8a07", "Toast"], ["f7927b", "Salmon"], ["98692d", "Cocoa Brown"], ["a27148", "Sienna"], ["7b554a", "Sepia"], ["4f3946", "Dark Sepia"], ["523a97", "Violet Blue"], ["0000a0", "Blue Ink"], ["0096de", "Solar Blue"], ["b2dd53", "Green Dust"], ["fa8fbb", "Crimson"], ["de649e", "Floral Pink"], ["b55066", "Wine"], ["5e5747", "Olive Drab"], ["4c881f", "Meadow"], ["e4dc79", "Canary Yellow"], ["cb8a1a", "Toast"], ["c6aa42", "Beige"], ["ecb02c", "Honey Dew"], ["f88040", "Tangerine"], ["ffe505", "Ocean Blue"], ["fa7a7a", "Sepia"], ["6be000", "Royal Purple"], ["386cae", "Yellow Ocher"], ["d0bab0", "Beige Grey"], ["e3be81", "Bamboo"]];
  // Husqvarna Viking (.hus). The codes are the maker's thread numbers.
  const HUS_CHART = [["000000", "Black", "026"], ["0000e7", "Blue", "005"], ["00c600", "Green", "002"], ["ff0000", "Red", "014"], ["840084", "Purple", "008"], ["ffff00", "Yellow", "020"], ["848484", "Grey", "024"], ["8484e7", "Light Blue", "006"], ["00ff84", "Light Green", "003"], ["ff7b31", "Orange", "017"], ["ff8ca5", "Pink", "011"], ["845200", "Brown", "028"], ["ffffff", "White", "022"], ["000084", "Dark Blue", "004"], ["008400", "Dark Green", "001"], ["7b0000", "Dark Red", "013"], ["ff6384", "Light Red", "015"], ["522952", "Dark Purple", "007"], ["ff00ff", "Light Purple", "009"], ["ffde00", "Dark Yellow", "019"], ["ffff9c", "Light Yellow", "021"], ["525252", "Dark Grey", "025"], ["d6d6d6", "Light Grey", "023"], ["ff5208", "Dark Orange", "016"], ["ff9c5a", "Light Orange", "018"], ["ff52b5", "Dark Pink", "010"], ["ffc6de", "Light Pink", "012"], ["523100", "Dark Brown", "027"], ["b5a584", "Light Brown", "029"]];
  // Husqvarna Viking (.shv; chart positions).
  const SHV_CHART = [["000000", "Black"], ["0000ff", "Blue"], ["33cc66", "Green"], ["ff0000", "Red"], ["ff00ff", "Purple"], ["ffff00", "Yellow"], ["7f7f7f", "Gray"], ["339aff", "Light Blue"], ["00ff00", "Light Green"], ["ff7f00", "Orange"], ["ffa0b4", "Pink"], ["994b00", "Brown"], ["ffffff", "White"], ["000000", "Black"], ["000000", "Black"], ["000000", "Black"], ["000000", "Black"], ["000000", "Black"], ["000000", "Black"], ["ff7f7f", "Light Red"], ["ff7fff", "Light Purple"], ["ffff99", "Light Yellow"], ["c0c0c0", "Light Gray"], ["000000", "Black"], ["000000", "Black"], ["ffa541", "Light Orange"], ["ffcccc", "Light Pink"], ["af5a0a", "Light Brown"], ["000000", "Black"], ["000000", "Black"], ["000000", "Black"], ["000000", "Black"], ["000000", "Black"], ["00007f", "Dark Blue"], ["007f00", "Dark Green"], ["7f0000", "Dark Red"], ["7f007f", "Dark Purple"], ["c8c800", "Dark Yellow"], ["3c3c3c", "Dark Gray"], ["000000", "Black"], ["000000", "Black"], ["e83f00", "Dark Orange"], ["ff667a", "Dark Pink"]];
  // Pfaff (.pcm): 16 plain colors.
  const PCM_CHART = ["000000", "000080", "0000ff", "008080", "00ffff", "800080", "ff00ff", "800000", "ff0000", "008000", "00ff00", "808000", "ffff00", "808080", "c0c0c0", "ffffff"].map((h, i) => [h, "Color " + (i + 1)]);

  const fromChart = (chart, brand, chartName, index) => {
    const e = chart[index];
    return e ? { hex: e[0], brand, code: e[2] || "", name: e[1] || "", chart: chartName + " " + index } : null;
  };
  const rgbColor = (n) => ({ hex: (n & 0xFFFFFF).toString(16).padStart(6, "0"), brand: "", code: "", name: "", chart: "" });

  // ---- Byte reader ----
  function Reader(buffer) {
    this.d = new Uint8Array(buffer); this.p = 0;
  }
  Reader.prototype = {
    left() { return this.d.length - this.p; },
    seek(p) { this.p = p; return this; },
    skip(n) { this.p += n; return this; },
    u8() { return this.p < this.d.length ? this.d[this.p++] : null; },
    s8() { const v = this.u8(); return v == null ? null : (v > 127 ? v - 256 : v); },
    bytes(n) { const b = this.d.subarray(this.p, this.p + n); this.p += n; return b; },
    u16le() { if (this.left() < 2) { this.p = this.d.length; return null; } const d = this.d, p = this.p; this.p += 2; return d[p] | (d[p + 1] << 8); },
    u16be() { if (this.left() < 2) { this.p = this.d.length; return null; } const d = this.d, p = this.p; this.p += 2; return (d[p] << 8) | d[p + 1]; },
    u24le() { if (this.left() < 3) { this.p = this.d.length; return null; } const d = this.d, p = this.p; this.p += 3; return d[p] | (d[p + 1] << 8) | (d[p + 2] << 16); },
    u24be() { if (this.left() < 3) { this.p = this.d.length; return null; } const d = this.d, p = this.p; this.p += 3; return (d[p] << 16) | (d[p + 1] << 8) | d[p + 2]; },
    u32le() { if (this.left() < 4) { this.p = this.d.length; return null; } const d = this.d, p = this.p; this.p += 4; return (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0; },
    u32be() { if (this.left() < 4) { this.p = this.d.length; return null; } const d = this.d, p = this.p; this.p += 4; return ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0; },
    str(n) { const b = this.bytes(n); try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch (e) { return ""; } },
    str16(n) { const b = this.bytes(n); try { return new TextDecoder("utf-16le").decode(b); } catch (e) { return ""; } },
  };
  const s16 = (v) => (v & 0xFFFF) > 0x7FFF ? (v & 0xFFFF) - 0x10000 : (v & 0xFFFF);
  const s24 = (v) => (v & 0xFFFFFF) > 0x7FFFFF ? (v & 0xFFFFFF) - 0x1000000 : (v & 0xFFFFFF);
  const s32 = (v) => v | 0;
  const s8 = (v) => v > 127 ? v - 256 : v;

  // ---- Stitch builder: every reader feeds it pyembroidery-style moves (relative, Y pointing DOWN) ----
  function Out() {
    this.x = 0; this.y = 0; this.stitches = []; this.stop = 0; this.stitched = false; this.colorChanges = 0;
    this.stitchCount = 0; this.cur = null; this.curNeedle = null; this.fileColors = []; this.needles = [];
    this.minX = Infinity; this.minY = Infinity; this.maxX = -Infinity; this.maxY = -Infinity;
  }
  Out.prototype = {
    // What the file says the current (not yet stitched) block's thread is.
    color(info) { this.cur = info || null; },
    needle(n) { this.curNeedle = n == null ? null : n; },
    // A color (or needle) change: the next block, once it stitches, is the next needle stop.
    change(info, needle) {
      this.colorChanges++;
      if (this.stitched) { this.stop++; this.stitched = false; }
      this.cur = info === undefined ? null : info;
      if (needle !== undefined) this.curNeedle = needle;
    },
    _point(jump) {
      const x = this.x, y = -this.y;   // Y up, like a .dst
      this.stitches.push({ x, y, jump, color: this.stop });
      if (jump) return;
      if (!this.stitched) { this.stitched = true; this.fileColors[this.stop] = this.cur || null; this.needles[this.stop] = this.curNeedle; }
      this.stitchCount++;
      if (x < this.minX) this.minX = x; if (y < this.minY) this.minY = y; if (x > this.maxX) this.maxX = x; if (y > this.maxY) this.maxY = y;
    },
    stitch(dx, dy) { this.x += dx; this.y += dy; this._point(false); },
    move(dx, dy) { if (!dx && !dy) return; this.x += dx; this.y += dy; this._point(true); },
    stitchAbs(x, y) { this.x = x; this.y = y; this._point(false); },
    moveAbs(x, y) { this.x = x; this.y = y; this._point(true); },
    done(kind) {
      if (!this.stitchCount) throw new Error("No stitches found in this " + kind + " file.");
      // Units are 0.1 mm: a design over a metre across means the file was misread, not a real design.
      if (this.maxX - this.minX > 10000 || this.maxY - this.minY > 10000) throw new Error("This " + kind + " file couldn't be read (its stitches don't make sense).");
      const needleStops = this.stop + (this.stitched ? 1 : 0);
      const fileColors = Array.from({ length: needleStops }, (_, i) => this.fileColors[i] || null);
      const needles = Array.from({ length: needleStops }, (_, i) => this.needles[i] == null ? null : this.needles[i]);
      return { stitches: this.stitches, needleStops, colorChanges: this.colorChanges, stitchCount: this.stitchCount,
        bbox: { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY },
        fileColors, needles: needles.some(n => n != null) ? needles : [] };
    },
  };
  const tooShort = (r, n, kind) => { if (r.d.length < n) throw new Error("File is too short to be a " + kind + " file."); };

  // ---- Brother: .pec / .pes / .phb / .phc (stitches in the PEC block) ----
  function pecStitches(r, out) {
    for (;;) {
      let v1 = r.u8(), v2 = r.u8();
      if (v2 == null || (v1 === 0xFF && v2 === 0x00)) break;
      if (v1 === 0xFE && v2 === 0xB0) { r.skip(1); out.next(); continue; }
      let jump = false, trim = false, x, y;
      if (v1 & 0x80) {
        if (v1 & 0x20) trim = true;
        if (v1 & 0x10) jump = true;
        x = (((v1 << 8) | v2) & 0xFFF); if (x > 0x7FF) x -= 0x1000;
        v2 = r.u8(); if (v2 == null) break;
      } else x = v1 > 63 ? v1 - 128 : v1;
      if (v2 & 0x80) {
        if (v2 & 0x20) trim = true;
        if (v2 & 0x10) jump = true;
        const v3 = r.u8(); if (v3 == null) break;
        y = (((v2 << 8) | v3) & 0xFFF); if (y > 0x7FF) y -= 0x1000;
      } else y = v2 > 63 ? v2 - 128 : v2;
      if (jump || trim) out.move(x, y); else out.stitch(x, y);
    }
  }
  // The thread of each color block: the PES header's own list (brand, code, name, RGB) when it has one, else
  // Brother's chart by the PEC block's color numbers. Mirrors pyembroidery's map_pec_colors.
  function pecBlockColors(colorBytes, pesThreads) {
    const chartColor = (b) => fromChart(PEC_CHART, "Brother", "Brother chart", b % PEC_CHART.length);
    if (!pesThreads || !pesThreads.length) return Array.from(colorBytes, chartColor);
    if (pesThreads.length >= colorBytes.length) return pesThreads.slice();
    const list = pesThreads.slice(), byIndex = {};
    return Array.from(colorBytes, (b) => {
      const k = b % PEC_CHART.length;
      if (!(k in byIndex)) byIndex[k] = list.length ? list.shift() : chartColor(b);
      return byIndex[k];
    });
  }
  // Feeds the block colors to the builder as the stitches cross each color change.
  function withBlockColors(out, colors) {
    let i = 0;
    out.color(colors[0]);
    out.next = () => { i++; out.change(colors[i] || null); };
    return out;
  }
  function readPecBlock(r, pesThreads) {
    r.skip(3);                    // "LA:"
    r.skip(16);                   // label
    r.skip(0xF);
    r.u8(); r.u8();               // icon stride, height
    r.skip(0xC);
    const colorChanges = r.u8();
    if (colorChanges == null) throw new Error("This PEC block is cut short.");
    const colorBytes = r.bytes(colorChanges + 1);
    r.skip(0x1D0 - colorChanges);
    r.u24le();                    // end of the stitch block
    r.skip(0x0B);
    const out = withBlockColors(new Out(), pecBlockColors(colorBytes, pesThreads));
    pecStitches(r, out);
    return out;
  }
  function readPec(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x220, "PEC");
    if (r.str(8) !== "#PEC0001") throw new Error("This isn't a PEC file (no #PEC0001 at the start).");
    return readPecBlock(r).done("PEC");
  }
  function pesString(r) { const n = r.u8(); return n ? r.str(n) : ""; }
  function pesThread(r) {
    const code = pesString(r), rgb = r.u24be(); r.skip(5);
    const name = pesString(r), brand = pesString(r), chart = pesString(r);
    return { hex: rgb.toString(16).padStart(6, "0"), brand: (brand || "").trim(), code: (code || "").trim(), name: (name || "").trim(), chart: (chart || "").trim() };
  }
  // PES v5 and later list the design's threads in the header. [skip after metadata, skip after the image name]
  // per version, from pyembroidery's PesReader; v9/v10 also carry a hoop name first.
  const PES_HEADER = { "#PES0050": [24, 24], "#PES0055": [24, 24], "#PES0056": [24, 24], "#PES0060": [36, 24], "#PES0070": [36, 24], "#PES0080": [38, 26], "#PES0090": [30, 34, true], "#PES0100": [38, 34, true] };
  function readPes(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x30, "PES");
    const magic = r.str(8);
    if (magic === "#PEC0001") return readPecBlock(r).done("PES");
    if (!/^#PES\d{4}$/.test(magic)) throw new Error("This isn't a PES file (no #PES at the start).");
    const pecAt = r.u32le();
    const threads = [];
    const layout = PES_HEADER[magic];
    if (layout) {
      try {
        r.skip(4);
        for (let i = 0; i < 5; i++) pesString(r);          // name, category, author, keywords, comments
        if (layout[2]) { r.skip(14); pesString(r); }       // hoop name
        r.skip(layout[0]); pesString(r);                   // image file
        r.skip(layout[1]);
        // Programmable fills, motifs and feather patterns come before the threads; pyembroidery stops if any.
        if (!r.u16le() && !r.u16le() && !r.u16le()) {
          const n = r.u16le() || 0;
          for (let i = 0; i < n && r.left() > 0; i++) threads.push(pesThread(r));
        }
      } catch (e) { threads.length = 0; }
    }
    if (!pecAt || pecAt >= r.d.length) throw new Error("This PES file has no PEC block.");
    r.seek(pecAt);
    return readPecBlock(r, threads).done("PES");
  }
  function readPhb(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x80, "PHB");
    r.seek(0x71);
    const n = r.u16le() || 0, colors = [];
    for (let i = 0; i < n; i++) { const b = r.u8(); if (b == null) break; colors.push(fromChart(PEC_CHART, "Brother", "Brother chart", b % PEC_CHART.length)); }
    let at = 0x52;
    r.seek(0x54); at += r.u32le();
    r.seek(at); at += r.u32le() + 2;
    r.seek(at); at += r.u32le();
    r.seek(at + 14);
    const cc2 = r.u8();
    r.skip(cc2 + 0x15);
    const out = withBlockColors(new Out(), colors);
    pecStitches(r, out);
    return out.done("PHB");
  }
  function readPhc(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x80, "PHC");
    r.seek(0x4A);
    r.skip(3);   // icon height, a byte, icon stride
    const n = r.u16le() || 0, colors = [];
    for (let i = 0; i < n; i++) { const b = r.u8(); if (b == null) break; colors.push(fromChart(PEC_CHART, "Brother", "Brother chart", b % PEC_CHART.length)); }
    r.seek(0x2B);
    const pecAdd = r.u8(); r.skip(4);
    const pecOffset = r.u16le();
    r.seek(pecOffset + pecAdd);
    const b1 = r.u16le(); r.skip(b1);
    const b2 = r.u32le(); r.skip(b2 + 10);
    const cc2 = r.u8(); r.skip(cc2 + 0x1D);
    const out = withBlockColors(new Out(), colors);
    pecStitches(r, out);
    return out.done("PHC");
  }

  // ---- Janome: .jef, .sew ----
  function readJef(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x74, "JEF");
    const stitchAt = r.u32le(); r.skip(20);
    const n = r.u32le(); r.skip(88);
    if (n > 1000) throw new Error("This isn't a JEF file (it lists " + n + " colors).");
    const list = [];   // null = position 0: a stop, not a color
    for (let i = 0; i < n; i++) { const k = Math.abs(s32(r.u32le() || 0)); list.push(k === 0 ? null : fromChart(JEF_CHART, "Janome", "Janome chart", k % JEF_CHART.length)); }
    r.seek(stitchAt);
    const out = new Out();
    out.color(list[0]);
    let ci = 1;
    while (r.left() >= 2) {
      const b0 = r.u8(), b1 = r.u8();
      if (b0 !== 0x80) { out.stitch(s8(b0), -s8(b1)); continue; }
      if (r.left() < 2) break;
      const x = s8(r.u8()), y = -s8(r.u8());
      if (b1 === 0x02) { out.move(x, y); continue; }
      if (b1 === 0x01) {
        if (ci < list.length && list[ci] === null) list.splice(ci, 1);   // a stop: same thread goes on
        else { out.change(list[ci] || null); ci++; }
        continue;
      }
      break;   // 0x10 = end, or a code this reader doesn't know
    }
    return out.done("JEF");
  }
  function readSew(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x1D78, "SEW");
    const n = r.u16le(), list = [];
    for (let i = 0; i < n; i++) list.push(fromChart(SEW_CHART, "Janome", "Janome chart", (r.u16le() || 0) % SEW_CHART.length));
    r.seek(0x1D78);
    const out = new Out();
    out.color(list[0]); let ci = 1;
    while (r.left() >= 2) {
      const b0 = r.u8(), b1 = r.u8();
      if (b0 !== 0x80) { out.stitch(s8(b0), -s8(b1)); continue; }
      if (r.left() < 2) break;
      const x = s8(r.u8()), y = -s8(r.u8());
      if (b1 & 1) { out.change(list[ci++] || null); continue; }
      if (b1 === 0x04 || b1 === 0x02) { out.move(x, y); continue; }
      if (b1 === 0x10) { out.stitch(x, y); continue; }
      break;
    }
    return out.done("SEW");
  }

  // ---- Pfaff / Husqvarna Viking: .vp3 ----
  function readVp3(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x60, "VP3");
    const magic = r.bytes(6);
    if (String.fromCharCode(...magic.subarray(0, 5)) !== "%vsm%") throw new Error("This isn't a VP3 file (no %vsm% at the start).");
    const skipStr = () => { const n = r.u16be(); r.skip(n || 0); };
    const str8 = () => { const n = r.u16be(); return n ? r.str(n) : ""; };
    skipStr(); r.skip(7); skipStr(); r.skip(32);
    const cx = s32(r.u32be()) / 100, cy = -(s32(r.u32be()) / 100);
    r.skip(27); skipStr(); r.skip(24); skipStr();
    const n = r.u16be() || 0;
    const out = new Out();
    for (let b = 0; b < n && r.left() > 0; b++) {
      r.skip(3);
      const dist = r.u32be(); const end = dist + r.p;
      const sx = s32(r.u32be()) / 100, sy = -(s32(r.u32be()) / 100);
      const ax = sx + cx, ay = sy + cy;
      if (ax !== 0 && ay !== 0) out.moveAbs(ax, ay);
      const parts = r.u8(); r.u8();
      let rgb = 0;
      for (let m = 0; m < parts; m++) { rgb = r.u24be(); r.u8(); r.u16be(); }
      r.u8(); r.u8();
      const code = str8(), name = str8(), brand = str8();
      out.color({ hex: (rgb & 0xFFFFFF).toString(16).padStart(6, "0"), brand: brand.trim(), code: code.trim(), name: name.trim(), chart: "" });
      r.skip(15); r.skip(3);
      const bytes = r.bytes(Math.max(0, end - r.p));
      let i = 0;
      while (i < bytes.length - 1) {
        const x = s8(bytes[i]), y = s8(bytes[i + 1]); i += 2;
        if (bytes[i - 2] !== 0x80) { out.stitch(x, y); continue; }
        if (y === 0x01) {
          if (i + 4 > bytes.length) break;
          const lx = s16((bytes[i] << 8) | bytes[i + 1]); i += 2;
          const ly = s16((bytes[i] << 8) | bytes[i + 1]); i += 2;
          out.stitch(lx, ly); i += 2;
        }
        // 0x02: no known effect; 0x03: trim
      }
      r.seek(end);
      if (b + 1 < n) out.change(null);
    }
    return out.done("VP3");
  }

  // ---- Singer: .xxx ----
  function readXxx(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x100, "XXX");
    r.seek(0x27);
    const n = r.u16le() || 0;
    r.seek(0x100);
    const out = new Out(), events = [];   // the colors come after the stitches, so the moves are kept first
    for (;;) {
      const b1 = r.u8(); if (b1 == null) break;
      if (b1 === 0x7D || b1 === 0x7E) { const x = r.u16le(), y = r.u16le(); if (y == null) break; events.push(["m", s16(x), -s16(y)]); continue; }
      const b2 = r.u8(); if (b2 == null) break;
      if (b1 !== 0x7F) { events.push(["s", s8(b1), -s8(b2)]); continue; }
      const b3 = r.u8(), b4 = r.u8(); if (b4 == null) break;
      if (b2 === 0x01) { events.push(["m", s8(b3), -s8(b4)]); continue; }
      if (b2 === 0x03) { events.push(["m", s8(b3), -s8(b4)]); continue; }
      if (b2 >= 0x08 && b2 <= 0x17) { events.push(["c"]); continue; }   // 0x09 too: files from the shop's archive use it
      if (b2 === 0x7F || b2 === 0x18) break;   // end; any other code is skipped
    }
    r.skip(2);
    const colors = [];
    for (let i = 0; i < n; i++) { const c = r.u32be(); if (c == null) break; colors.push(rgbColor(c)); }
    let ci = 0; out.color(colors[0]);
    for (const e of events) {
      if (e[0] === "s") out.stitch(e[1], e[2]);
      else if (e[0] === "m") out.move(e[1], e[2]);
      else out.change(colors[++ci] || null);
    }
    return out.done("XXX");
  }

  // ---- Pfaff: .pcs (RGB) and .pcm (chart), absolute 24-bit positions ----
  function readPcRecords(r, out, be, colors) {
    let ci = 0; out.color(colors[0]);
    const ratio = 5 / 3;
    for (;;) {
      let x, y, ctrl;
      if (be) { x = r.u24be(); r.u8(); y = r.u24be(); r.u8(); ctrl = r.u8(); }
      else { r.u8(); x = r.u24le(); r.u8(); y = r.u24le(); ctrl = r.u8(); }
      if (ctrl == null || x == null || y == null) break;
      x = s24(x) * ratio; y = -s24(y) * ratio;
      if (ctrl === 0) { out.stitchAbs(x, y); continue; }
      if (ctrl & 0x01) { out.change(colors[++ci] || null); continue; }
      if (ctrl & 0x04) { out.moveAbs(x, y); continue; }
      break;
    }
  }
  function readPcs(buffer) {
    const r = new Reader(buffer); tooShort(r, 8, "PCS");
    r.u8(); r.u8();
    const n = r.u16le(), colors = [];
    if (n > 256) throw new Error("This isn't a PCS file (it lists " + n + " colors).");
    for (let i = 0; i < n; i++) { colors.push(rgbColor(r.u24be())); r.skip(1); }
    r.u16le();
    const out = new Out(); readPcRecords(r, out, false, colors);
    return out.done("PCS");
  }
  function readPcm(buffer) {
    const r = new Reader(buffer); tooShort(r, 8, "PCM");
    r.seek(2);
    const n = r.u16be(), colors = [];
    if (n > 256) throw new Error("This isn't a PCM file (it lists " + n + " colors).");
    for (let i = 0; i < n; i++) colors.push(fromChart(PCM_CHART, "Pfaff", "Pfaff chart", (r.u16be() || 0) % PCM_CHART.length));
    r.u16be();
    const out = new Out(); readPcRecords(r, out, true, colors);
    return out.done("PCM");
  }

  // ---- 2-byte record formats with an 0x80 escape: .exp (Melco), .stx (its stitches are EXP), .emd (Elna) ----
  function expStitches(r, out) {
    while (r.left() >= 2) {
      const b0 = r.u8(), b1 = r.u8();
      if (b0 !== 0x80) { out.stitch(s8(b0), -s8(b1)); continue; }
      if (r.left() < 2) break;
      const x = s8(r.u8()), y = -s8(r.u8());
      if (b1 === 0x80) continue;                       // trim
      if (b1 === 0x02) { out.stitch(x, y); continue; }
      if (b1 === 0x04) { out.move(x, y); continue; }
      if (b1 === 0x01) { out.change(null); out.move(x, y); continue; }
      break;
    }
  }
  function readExp(buffer) { const r = new Reader(buffer), out = new Out(); expStitches(r, out); return out.done("EXP"); }
  function readStx(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x18, "STX");
    r.seek(0x0C); r.u32le(); r.u32le(); const at = r.u32le();
    r.seek(at); const out = new Out(); expStitches(r, out); return out.done("STX");
  }
  function readEmd(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x32, "EMD");
    r.seek(0x30); const out = new Out();
    while (r.left() >= 2) {
      const b0 = r.u8(), b1 = r.u8();
      if (b0 !== 0x80) { out.stitch(s8(b0), -s8(b1)); continue; }
      if (b1 === 0x80) { if (r.left() < 2) break; out.move(s8(r.u8()), -s8(r.u8())); continue; }
      if (b1 === 0x2A) { out.change(null); continue; }
      if (b1 === 0x7D || b1 === 0xAD || b1 === 0x90) continue;
      break;   // 0xFD = end
    }
    return out.done("EMD");
  }

  // ---- 3-byte DST records with no header: .tap (Happy) ----
  function readTap(buffer) {
    const r = new Reader(buffer), out = new Out();
    const bit = (b, n) => (b >> n) & 1;
    while (r.left() >= 3) {
      const b0 = r.u8(), b1 = r.u8(), b2 = r.u8();
      if ((b2 & 0xF3) === 0xF3) break;
      const dx = bit(b2, 2) * 81 - bit(b2, 3) * 81 + bit(b1, 2) * 27 - bit(b1, 3) * 27 + bit(b0, 2) * 9 - bit(b0, 3) * 9 + bit(b1, 0) * 3 - bit(b1, 1) * 3 + bit(b0, 0) - bit(b0, 1);
      const dyUp = bit(b2, 5) * 81 - bit(b2, 4) * 81 + bit(b1, 5) * 27 - bit(b1, 4) * 27 + bit(b0, 5) * 9 - bit(b0, 4) * 9 + bit(b1, 7) * 3 - bit(b1, 6) * 3 + bit(b0, 7) - bit(b0, 6);
      if ((b2 & 0xC3) === 0xC3) { out.change(null); out.move(dx, -dyUp); continue; }
      if ((b2 & 0x83) === 0x83) { out.move(dx, -dyUp); continue; }
      out.stitch(dx, -dyUp);
    }
    return out.done("TAP");
  }

  // ---- 3-byte records with sign bits in a control byte ----
  // Barudan .u01: [ctrl, y, x]; 0x20 = x left, 0x40 = y down; low 5 bits: 0 stitch, 1 jump, 2–5 speed (+ move),
  // 6/7 trim, 8 stop, 9–23 needle change (needle = code − 8), 24 end.
  function readU01(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x103, "U01");
    r.seek(0x100); const out = new Out();
    while (r.left() >= 3) {
      const c = r.u8(), by = r.u8(), bx = r.u8();
      const dx = (c & 0x20) ? -bx : bx, dy = (c & 0x40) ? by : -by;
      const cmd = c & 0x1F;
      if (cmd === 0) { out.stitch(dx, dy); continue; }
      if (cmd === 1 || cmd === 3 || cmd === 5 || cmd === 6 || cmd === 7 || cmd === 8) { out.move(dx, dy); continue; }
      if (cmd === 2 || cmd === 4) { if (dx || dy) out.stitch(dx, dy); continue; }
      if (cmd >= 9 && cmd <= 0x17) { out.change(null, cmd - 8); out.move(dx, dy); continue; }
      break;
    }
    return out.done("U01");
  }
  // ZSK .dsz (512-byte header) and Gold Thread .gt (from 0x200): [y, x, ctrl]; 0x40 = x left, 0x20 = y down;
  // low 5 bits 0 stitch, 1 jump; 0x82 stop, 0x9B trim, 0x83–0x9A needle change (two codes per needle).
  function zStitches(r, out) {
    while (r.left() >= 3) {
      const by = r.u8(), bx = r.u8(), c = r.u8();
      const x = (c & 0x40) ? -bx : bx, y = (c & 0x20) ? by : -by;
      const lo = c & 0x1F;
      if (lo === 0) { out.stitch(x, y); continue; }
      if (lo === 1) { out.move(x, y); continue; }
      if (c === 0x82 || c === 0x9B) continue;
      if (c >= 0x83 && c <= 0x9A) { out.change(null, ((c - 0x83) >> 1) + 1); continue; }
      break;
    }
  }
  function readDsz(buffer) { const r = new Reader(buffer); tooShort(r, 512, "DSZ"); r.seek(512); const out = new Out(); zStitches(r, out); return out.done("DSZ"); }
  function readGt(buffer) { const r = new Reader(buffer); tooShort(r, 0x200, "GT"); r.seek(0x200); const out = new Out(); zStitches(r, out); return out.done("GT"); }
  // Toyota .10o: [ctrl, y, x]; 0x20 = x left, 0x40 = y down; low 5 bits 0 stitch, 0x10 jump; 0x85 color change.
  function read10o(buffer) {
    const r = new Reader(buffer), out = new Out();
    while (r.left() >= 3) {
      const c = r.u8(), by = r.u8(), bx = r.u8();
      const x = (c & 0x20) ? -bx : bx, y = (c & 0x40) ? by : -by;
      if ((c & 0x1F) === 0) { out.stitch(x, y); continue; }
      if ((c & 0x1F) === 0x10) { out.move(x, y); continue; }
      if (c === 0x8A || c === 0x82 || c === 0x81) continue;
      if (c === 0x85) { out.change(null); continue; }
      break;   // 0x87 = end
    }
    return out.done("10O");
  }
  // Inbro .inb (from 0x2000): [x, y, ctrl]; 0x40 = x left, 0x20 = y down; low 4 bits 0 stitch, 1 color change, 2 jump.
  function readInb(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x2003, "INB");
    r.seek(0x2000); const out = new Out();
    while (r.left() >= 3) {
      const bx = r.u8(), by = r.u8(), c = r.u8();
      const x = (c & 0x40) ? -bx : bx, y = (c & 0x20) ? by : -by;
      const lo = c & 0x0F;
      if (lo === 0) { out.stitch(x, y); continue; }
      if (lo === 1) { out.change(null); out.move(x, y); continue; }
      if (lo === 2) { out.move(x, y); continue; }
      break;
    }
    return out.done("INB");
  }
  // Pfaff .ksm (from 0x200): [y, x, ctrl]; 0x40 = x left, 0x20 = y down. Any move is a stitch unless trimmed.
  function readKsm(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x203, "KSM");
    r.seek(0x200); const out = new Out();
    let trimmed = false;
    while (r.left() >= 3) {
      const by = r.u8(), bx = r.u8(); let c = r.u8();
      const x = (c & 0x40) ? -bx : bx, y = (c & 0x20) ? by : -by;
      c &= 0x1F;
      if (x || y) { if (trimmed) out.move(x, y); else out.stitch(x, y); }
      if (c === 0) continue;
      if (c === 0x07 || c === 0x13 || c === 0x1D) { trimmed = true; continue; }
      if (c >= 0x17 && c <= 0x19) { trimmed = false; continue; }
      if (c >= 0x0B && c <= 0x12) { out.change(null, c - 0x0A); trimmed = true; continue; }
      if (c === 0x05) continue;
      if (c === 0x1B) { trimmed = false; continue; }
      break;   // 0x08 = end
    }
    return out.done("KSM");
  }
  // Ameco .new: [x, y, ctrl] after a 2-byte count; 0x40 = x left, 0x20 = y down; ctrl 0 stitch, 0x11 end,
  // bit 1 color change, bit 0 jump.
  function readNew(buffer) {
    const r = new Reader(buffer); tooShort(r, 5, "NEW");
    r.seek(2); const out = new Out();
    while (r.left() >= 3) {
      const bx = r.u8(), by = r.u8(); let c = r.u8();
      const x = (c & 0x40) ? -bx : bx, y = (c & 0x20) ? by : -by;
      c &= 0x1F;
      if (c === 0) { out.stitch(x, y); continue; }
      if (c === 0x11) break;
      if (c & 0x02) { out.change(null); continue; }
      if (c & 0x01) { out.move(x, y); continue; }
    }
    return out.done("NEW");
  }
  // Pfaff .max: absolute 24-bit positions, one color.
  function readMax(buffer) {
    const r = new Reader(buffer); tooShort(r, 0xD9, "MAX");
    r.seek(0xD5); const n = r.u32le(); const out = new Out();
    for (let i = 0; i < n; i++) {
      const x = r.u24le(); r.u8(); const y = r.u24le(); const c1 = r.u8();
      if (c1 == null) break;
      out.stitchAbs(s24(x) * 1.235, s24(y) * 1.235);
    }
    return out.done("MAX");
  }
  // Tajima .tbf: thread colors (RGB) by needle, a needle order, then [x, y, ctrl] records from 0x600.
  function readTbf(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x603, "TBF");
    r.seek(0x10A); const order = Array.from(r.bytes(0x100));
    r.seek(0x20E); const threads = [];
    while (r.u8() === 0x45) { threads.push(rgbColor(r.u24be())); r.u8(); }
    r.seek(0x600);
    const out = new Out(); let k = 0;
    const byNeedle = (n) => threads[n - 1] || null;
    while (r.left() >= 3) {
      const bx = r.u8(), by = r.u8(), c = r.u8();
      if (c === 0x80) { out.stitch(s8(bx), -s8(by)); continue; }
      if (c === 0x81) { const n = order[k++]; if (n) { out.change(byNeedle(n), n); } continue; }
      if (c === 0x90) { if (bx || by) out.move(s8(bx), -s8(by)); continue; }
      if (c === 0x40 || c === 0x86) continue;
      break;   // 0x8F = end
    }
    return out.done("TBF");
  }

  // ---- Husqvarna Viking: .hus (compressed) and .shv ----
  // The decompressor .hus files use (pyembroidery's EmbCompress): Huffman-coded literals and back-references.
  function expand(input, size) {
    let pos = 0, blockLeft = -1, chars = null, dists = null;
    const bits = (start, len) => {
      const end = start + len - 1, s = start >> 3, e = end >> 3;
      let v = 0;
      for (let i = s; i <= e; i++) v = (v * 256) + (input[i] || 0);
      const unused = (8 - ((end + 1) % 8)) % 8;
      return Math.floor(v / Math.pow(2, unused)) % Math.pow(2, len);
    };
    const peek = (n) => bits(pos, n), pop = (n) => { const v = peek(n); pos += n; return v; };
    const huff = (lengths, value) => {
      if (!lengths) return { lookup: () => [value, 0] };
      const width = Math.max(...lengths), table = [];
      let size2 = 1 << width;
      for (let bl = 1; bl <= width; bl++) { size2 /= 2; for (let i = 0; i < lengths.length; i++) if (lengths[i] === bl) for (let k = 0; k < size2; k++) table.push(i); }
      return { lookup: (v) => { const x = table[v >> (16 - width)]; return [x, lengths[x]]; } };
    };
    const varLen = () => { let m = pop(3); if (m !== 7) return m; for (let q = 0; q < 13; q++) { if (pop(1) === 1) m++; else break; } return m; };
    const loadBlock = () => {
      blockLeft = pop(16);
      let count = pop(5), lenH;
      if (count === 0) lenH = huff(null, pop(5));
      else { const ls = new Array(count).fill(0); let i = 0; while (i < count) { if (i === 3) i += pop(2); ls[i] = varLen(); i++; } lenH = huff(ls, 8); }
      count = pop(9);
      if (count === 0) chars = huff(null, pop(9));
      else {
        const ls = new Array(count).fill(0); let i = 0;
        while (i < count) {
          const h = lenH.lookup(peek(16)); let c = h[0]; pos += h[1];
          if (c === 0) i += 1; else if (c === 1) i += 3 + pop(4); else if (c === 2) i += 20 + pop(9); else { ls[i] = c - 2; i++; }
        }
        chars = huff(ls);
      }
      count = pop(5);
      if (count === 0) dists = huff(null, pop(5));
      else { const ls = []; for (let i = 0; i < count; i++) ls.push(varLen()); dists = huff(ls); }
    };
    const out = [], total = input.length * 8;
    let guard = 0;
    while (total > pos && (size == null || out.length <= size)) {
      if (++guard > 5e6) break;
      if (blockLeft <= 0) loadBlock();
      blockLeft--;
      const h = chars.lookup(peek(16)); pos += h[1];
      const ch = h[0];
      if (ch === undefined) break;
      if (ch <= 255) { out.push(ch); continue; }
      if (ch === 510) break;
      const len = ch - 253;
      const d = dists.lookup(peek(16)); pos += d[1];
      let back = d[0] === 0 ? 0 : (1 << (d[0] - 1)) + pop(d[0] - 1);
      back += 1;
      const at = out.length - back;
      if (at < 0) break;
      for (let i = 0; i < len; i++) out.push(out[at + i]);
    }
    return out;
  }
  function readHus(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x2A, "HUS");
    r.u32le(); const nStitches = r.u32le(), nColors = r.u32le();
    if (nColors > 1000) throw new Error("This isn't a HUS file (it lists " + nColors + " colors).");
    r.skip(8);
    const cmdAt = r.u32le(), xAt = r.u32le(), yAt = r.u32le();
    r.skip(8); r.u16le();
    const colors = [];
    for (let i = 0; i < nColors; i++) colors.push(fromChart(HUS_CHART, "Husqvarna Viking", "Viking chart", (r.u16le() || 0) % HUS_CHART.length));
    const d = r.d;
    const cmd = expand(d.subarray(cmdAt, xAt), nStitches), xs = expand(d.subarray(xAt, yAt), nStitches), ys = expand(d.subarray(yAt), nStitches);
    const n = Math.min(cmd.length, xs.length, ys.length);
    const out = new Out(); out.color(colors[0]); let ci = 0;
    for (let i = 0; i < n; i++) {
      const c = cmd[i], x = s8(xs[i]), y = -s8(ys[i]);
      if (c === 0x80) out.stitch(x, y);
      else if (c === 0x81) out.move(x, y);
      else if (c === 0x84) { out.change(colors[++ci] || null); out.move(x, y); }
      else if (c === 0x88) out.move(x, y);
      else break;
    }
    return out.done("HUS");
  }
  function readShv(buffer) {
    const r = new Reader(buffer); tooShort(r, 0x60, "SHV");
    r.seek(0x56);
    const nameLen = r.u8(); r.skip(nameLen);
    const w = r.u8(), h = r.u8();
    r.skip(4 + Math.ceil(h / 2) * w);
    const nColors = r.u8(); r.skip(18);
    const colors = [], perColor = [];
    for (let i = 0; i < nColors; i++) {
      perColor.push(r.u32be()); colors.push(fromChart(SHV_CHART, "Husqvarna Viking", "Viking chart", (r.u8() || 0) % SHV_CHART.length)); r.skip(9);
    }
    r.skip(-2);
    const out = new Out(); out.color(colors[0]);
    let inJump = false, since = 0, ci = 0, max = perColor[0] || 0;
    for (;;) {
      const b0 = r.u8(), b1 = r.u8();
      if (b1 == null) break;
      if (since >= max) {
        since = 0; ci++;
        if (ci >= perColor.length) break;   // every listed color is done: what's left is the end of the file
        max = perColor[ci]; out.change(colors[ci] || null);
      }
      if (b0 === 0x80) {
        since++;
        if (b1 === 3) continue;
        if (b1 === 2) { inJump = false; continue; }
        if (b1 === 1) { since += 2; const sx = s16(r.u16be()), sy = s16(r.u16be()); inJump = true; out.move(sx, sy); continue; }
      }
      since++;
      if (inJump) out.move(s8(b0), s8(b1)); else out.stitch(s8(b0), s8(b1));
    }
    // Larger .shv files use a header layout this reader doesn't know: their colors don't add up.
    if (perColor.length > 1 && ci + 1 < perColor.length) throw new Error("This SHV file's layout isn't one this page can read.");
    return out.done("SHV");
  }

  const READERS = { pes: readPes, pec: readPec, phb: readPhb, phc: readPhc, jef: readJef, sew: readSew, vp3: readVp3,
    xxx: readXxx, pcs: readPcs, pcm: readPcm, exp: readExp, stx: readStx, emd: readEmd, tap: readTap, u01: readU01,
    dsz: readDsz, gt: readGt, "10o": read10o, inb: readInb, ksm: readKsm, new: readNew, max: readMax, tbf: readTbf,
    hus: readHus, shv: readShv };

  window.StitchReaders = {
    exts: Object.keys(READERS),
    read(buffer, ext) {
      const fn = READERS[String(ext || "").toLowerCase()];
      if (!fn) throw new Error("This format can't be read.");
      return fn(buffer);
    },
    _expand: expand,
  };
})();
