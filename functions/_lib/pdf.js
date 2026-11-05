/**
 * A small PDF writer: enough to draw an invoice or a receipt, with no dependencies and no browser.
 *
 * Why not render the HTML invoice? A Worker has no browser, and Cloudflare's Browser Rendering is a
 * paid extra; the desktop program has Chromium but the web install doesn't. This makes the same
 * document anywhere the code runs, on the free plan.
 *
 * What it can do: text in Helvetica or Helvetica-Bold (the PDF standard fonts — every reader has them,
 * nothing is embedded), lines and filled boxes, several pages, Letter or A4. Text is Windows-1252
 * ("WinAnsi"): a character outside it is replaced by the nearest plain one, or "?", never an error.
 *
 *   const doc = pdfDocument({ pageSize: "Letter" });
 *   doc.text(50, 60, "Hello", { size: 12, bold: true, align: "left" });   // y measured from the TOP
 *   doc.line(50, 70, 300, 70); doc.rect(50, 80, 100, 20, { fill: "#eeeeee" });
 *   doc.newPage();
 *   const bytes = doc.bytes();   // Uint8Array
 *
 * pdfTextWidth(text, size, bold) and pdfWrap(text, width, size, bold) measure and break text.
 * No imports, so every test harness can load it on its own.
 */

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for character codes 32–126, from the fonts'
// published metrics. Anything else is measured as a typical letter (556).
const PDF_HELV_ = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const PDF_HELV_BOLD_ = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
// The few characters above 126 the documents use, and their Windows-1252 codes and widths.
const PDF_EXTRA_ = { "—": [0x97, 1000], "–": [0x96, 556], "•": [0x95, 350], "’": [0x92, 222], "‘": [0x91, 222],
  "“": [0x93, 333], "”": [0x94, 333], "…": [0x85, 1000], "×": [0xD7, 584], " ": [0x20, 278] };
// Characters with no Windows-1252 code: a plain stand-in.
const PDF_SUBST_ = { "−": "-", "→": "->", "←": "<-", "✓": "v", "⚡": "!", "­": "" };

// Text → [{code, width}] in Windows-1252.
function pdfGlyphs_(text, bold) {
  const out = [];
  for (let ch of String(text == null ? "" : text).normalize("NFC")) {
    if (PDF_SUBST_[ch] != null) { for (const c of PDF_SUBST_[ch]) out.push(...pdfGlyphs_(c, bold)); continue; }
    const cp = ch.codePointAt(0);
    if (cp >= 32 && cp <= 126) out.push({ code: cp, width: (bold ? PDF_HELV_BOLD_ : PDF_HELV_)[cp - 32] });
    else if (PDF_EXTRA_[ch]) out.push({ code: PDF_EXTRA_[ch][0], width: PDF_EXTRA_[ch][1] });
    else if (cp >= 0xA1 && cp <= 0xFF) out.push({ code: cp, width: 556 });   // Latin-1 letters keep their code in 1252
    else if (cp === 9 || cp === 10 || cp === 13) out.push({ code: 32, width: 278 });
    else {
      // An accented letter outside Latin-1: its plain letter; anything else: "?".
      const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (plain !== ch && plain.length && plain.codePointAt(0) < 127) out.push(...pdfGlyphs_(plain, bold));
      else out.push({ code: 63, width: (bold ? PDF_HELV_BOLD_ : PDF_HELV_)[63 - 32] });
    }
  }
  return out;
}

export function pdfTextWidth(text, size, bold) {
  return pdfGlyphs_(text, bold).reduce((t, g) => t + g.width, 0) * (Number(size) || 10) / 1000;
}

// Breaks text into lines no wider than `width` points (on spaces; a single word that is too long is
// cut). Line breaks in the text are kept.
export function pdfWrap(text, width, size, bold) {
  const out = [];
  for (const para of String(text == null ? "" : text).split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (let w of words) {
      while (pdfTextWidth(w, size, bold) > width && w.length > 1) {
        // A word wider than the line on its own: put what fits, carry the rest.
        if (line) { out.push(line); line = ""; }
        let n = w.length;
        while (n > 1 && pdfTextWidth(w.slice(0, n), size, bold) > width) n--;
        out.push(w.slice(0, n)); w = w.slice(n);
      }
      const next = line ? line + " " + w : w;
      if (line && pdfTextWidth(next, size, bold) > width) { out.push(line); line = w; } else line = next;
    }
    out.push(line);
  }
  return out;
}

const PDF_PAGE_SIZES_ = { Letter: [612, 792], A4: [595.28, 841.89] };
const pdfNum_ = (n) => (Math.round(Number(n) * 100) / 100).toString();
// "#1f5f8b" → "0.122 0.373 0.545"
function pdfColor_(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "")); if (!m) return "0 0 0";
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(c => pdfNum_(c / 255)).join(" ");
}
// A PDF string of Windows-1252 codes: ( ) \ escaped, everything outside printable ASCII as octal.
function pdfString_(glyphs) {
  let s = "(";
  for (const g of glyphs) {
    const c = g.code;
    if (c === 40 || c === 41 || c === 92) s += "\\" + String.fromCharCode(c);
    else if (c >= 32 && c <= 126) s += String.fromCharCode(c);
    else s += "\\" + c.toString(8).padStart(3, "0");
  }
  return s + ")";
}

export function pdfDocument({ pageSize = "Letter", title = "" } = {}) {
  const [W, H] = PDF_PAGE_SIZES_[pageSize] || PDF_PAGE_SIZES_.Letter;
  const pages = [[]];
  const cur = () => pages[pages.length - 1];
  const api = {
    width: W, height: H,
    pageCount: () => pages.length,
    newPage() { pages.push([]); return api; },
    // y is measured from the top of the page to the text's baseline.
    text(x, y, text, { size = 10, bold = false, color = "", align = "left" } = {}) {
      const glyphs = pdfGlyphs_(text, bold);
      if (!glyphs.length) return api;
      const w = glyphs.reduce((t, g) => t + g.width, 0) * size / 1000;
      const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      cur().push(`BT /${bold ? "F2" : "F1"} ${pdfNum_(size)} Tf ${color ? pdfColor_(color) + " rg " : "0 0 0 rg "}${pdfNum_(left)} ${pdfNum_(H - y)} Td ${pdfString_(glyphs)} Tj ET`);
      return api;
    },
    line(x1, y1, x2, y2, { color = "#cccccc", width = 0.75 } = {}) {
      cur().push(`${pdfColor_(color)} RG ${pdfNum_(width)} w ${pdfNum_(x1)} ${pdfNum_(H - y1)} m ${pdfNum_(x2)} ${pdfNum_(H - y2)} l S`);
      return api;
    },
    // x, y = the box's top-left corner.
    rect(x, y, w, h, { fill = "", stroke = "", width = 1 } = {}) {
      const box = `${pdfNum_(x)} ${pdfNum_(H - y - h)} ${pdfNum_(w)} ${pdfNum_(h)} re`;
      if (fill && stroke) cur().push(`${pdfColor_(fill)} rg ${pdfColor_(stroke)} RG ${pdfNum_(width)} w ${box} B`);
      else if (fill) cur().push(`${pdfColor_(fill)} rg ${box} f`);
      else cur().push(`${pdfColor_(stroke || "#000000")} RG ${pdfNum_(width)} w ${box} S`);
      return api;
    },
    bytes() {
      // Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info, then a page + its content for each page.
      const objs = [];
      const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ");
      objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
      objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
      objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
      objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
      objs[5] = `<< /Producer (OpenDecoDesk)${title ? " /Title " + pdfString_(pdfGlyphs_(title, false)) : ""} >>`;
      pages.forEach((ops, i) => {
        const content = ops.join("\n");
        objs[6 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNum_(W)} ${pdfNum_(H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + i * 2} 0 R >>`;
        objs[7 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
      });
      // Everything above is plain ASCII (strings are octal-escaped), so string length = byte length.
      let out = "%PDF-1.4\n%âãÏÓ\n";
      const offsets = [];
      for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
      const xref = out.length;
      out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
      out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      const bytes = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
      return bytes;
    },
  };
  return api;
}

// Bytes → base64, in chunks (a whole PDF at once can be too many arguments for String.fromCharCode).
export function pdfBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
