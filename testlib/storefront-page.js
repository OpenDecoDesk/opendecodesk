// The shop page as the JSDOM tests load it: public/index.html with public/storefront.js put back inline,
// where its <script src="/storefront.js"> tag is. JSDOM then runs it the way a browser runs the tag (at
// the end of <body>, before anything after it) and at once: a test can call the page's functions as
// soon as `new JSDOM()` returns, without a resource loader that serves the file.
//
// The real page loads it as a file: the Content-Security-Policy in public/_headers runs no inline script
// (test249_no_inline_scripts.js checks the page has none; the end-to-end suite checks it in a browser).
// Tests that look for a piece of the page's source text find it here too, page and script together.
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
const TAG = '<script src="/storefront.js"></script>';

function storefrontPage() {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(PUBLIC, "storefront.js"), "utf8");
  if (!html.includes(TAG)) throw new Error("public/index.html no longer loads " + TAG);
  if (/<\/script/i.test(js)) throw new Error("public/storefront.js has a </script> in it: it can't be put inline");
  return html.replace(TAG, () => "<script>\n" + js + "</script>");
}

module.exports = { storefrontPage };
