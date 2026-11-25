// The shop page as the JSDOM tests load it: public/index.html with public/storefront.js put back inline,
// where its <script src="/storefront.js"> tag is. JSDOM then runs it the way a browser runs the tag (at
// the end of <body>, before anything after it) and at once: a test can call the page's functions as
// soon as `new JSDOM()` returns, without a resource loader that serves the file.
//
// The real page loads it as a file: the Content-Security-Policy in public/_headers runs no inline script
// (test249_no_inline_scripts.js checks the page has none; the end-to-end suite checks it in a browser).
// Tests that look for a piece of the page's source text find it here too, page and script together.
//
// The admin's styles (public/admin.css, review #104) are put in too, as the <style data-admin-css> the page
// has once loadAdminScript has added them — so the admin screens a test draws are styled as in a browser,
// and no test's resource loader is asked for the file. loadAdminScript leaves a page that already has them
// as it is. { adminCss: false } gives the page as a shop's visitor gets it (test30 checks the loading).
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
const TAG = '<script src="/storefront.js"></script>';

function storefrontPage({ adminCss = true } = {}) {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(PUBLIC, "storefront.js"), "utf8");
  if (!html.includes(TAG)) throw new Error("public/index.html no longer loads " + TAG);
  if (/<\/script/i.test(js)) throw new Error("public/storefront.js has a </script> in it: it can't be put inline");
  let page = html.replace(TAG, () => "<script>\n" + js + "</script>");
  if (adminCss) {
    const css = fs.readFileSync(path.join(PUBLIC, "admin.css"), "utf8");
    if (/<\/style/i.test(css)) throw new Error("public/admin.css has a </style> in it: it can't be put inline");
    if (!page.includes("</head>")) throw new Error("public/index.html has no </head>");
    page = page.replace("</head>", () => "<style data-admin-css>\n" + css + "</style>\n</head>");
  }
  return page;
}

module.exports = { storefrontPage };
