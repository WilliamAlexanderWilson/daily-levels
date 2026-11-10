const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const siteRoot = path.join(__dirname, "..", "site");

function jpegDimensions(buffer) {
  assert.equal(buffer.readUInt16BE(0), 0xffd8);
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("JPEG dimensions were not found");
}

test("the public dashboard identifies William Wilson as its owner", () => {
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.match(html, /William Wilson's Range Desk/);
  assert.match(html, /by William Wilson/);
  assert.match(html, /<meta name="description" content="William Wilson's evidence-first range dashboard/);
  assert.match(html, /<link rel="canonical" href="https:\/\/williamalexanderwilson\.github\.io\/daily-levels\/"/);
  assert.match(html, /<meta property="og:image" content="https:\/\/williamalexanderwilson\.github\.io\/daily-levels\/social-preview\.jpg"/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(html, /<link id="site-favicon" rel="icon" type="image\/svg\+xml" href="brand-btc\.svg"/);
  assert.match(html, /<a class="brand-mark" href="\.\/" aria-label="Range Desk home">/);
  assert.match(html, /<img id="brand-mark-img" src="brand-btc\.svg" width="42" height="42" alt=""/);
  assert.match(html, />Source code<\/a>/);
  assert.match(html, />Research notes<\/a>/);
  assert.equal(fs.existsSync(path.join(siteRoot, "favicon.svg")), true);
  assert.equal(fs.existsSync(path.join(siteRoot, "social-preview.jpg")), true);
  assert.equal(fs.existsSync(path.join(siteRoot, "..", "docs", "assets", "range-desk-dashboard.jpg")), true);
  for (const asset of ["btc", "eth", "spy", "qqq", "nvda"]) {
    assert.equal(fs.existsSync(path.join(siteRoot, `brand-${asset}.svg`)), true);
  }
});

test("the active chart controls the header mark and browser favicon", () => {
  const app = fs.readFileSync(path.join(siteRoot, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.match(html, /<script src="asset-brand\.js\?v=[^"]+"><\/script>\s*<script src="chart-time\.js\?v=[^"]+"><\/script>\s*<script src="candle-style\.js\?v=[^"]+"><\/script>\s*<script src="doji-study\.js\?v=[^"]+"><\/script>\s*<script src="app\.js\?v=[^"]+"><\/script>/);
  assert.match(app, /AssetBrand\.apply\(document, state\.asset\)/);
});

test("the public product images meet their publishing contracts", () => {
  const socialPath = path.join(siteRoot, "social-preview.jpg");
  const dashboardPath = path.join(siteRoot, "..", "docs", "assets", "range-desk-dashboard.jpg");
  const social = fs.readFileSync(socialPath);
  const dashboard = fs.readFileSync(dashboardPath);
  assert.deepEqual(jpegDimensions(social), { width: 1280, height: 640 });
  assert.deepEqual(jpegDimensions(dashboard), { width: 1600, height: 1000 });
  assert.ok(social.length < 1_000_000, "GitHub social preview must stay under 1 MB");
});

test("product branding stays separate from the range method provenance", () => {
  const source = fs.readFileSync(path.join(siteRoot, "range-decision.js"), "utf8");
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.match(source, /sourceLabel: "Sourced macro-range framework"/);
  assert.match(source, /sourceUrl: "#range-method-sources"/);
  assert.doesNotMatch(source, /sourceLabel:\s*["']William Wilson/);
  assert.match(html, /How this is calculated/);
  for (const sourceId of ["cOxjsDvGRTA", "HBKEvXjDbS0", "v3fXVye-TVg"]) {
    assert.match(html, new RegExp(`https:\\/\\/youtu\\.be\\/${sourceId}`));
  }
  const app = fs.readFileSync(path.join(siteRoot, "app.js"), "utf8");
  assert.match(app, /range-method-sources["']\)\.hidden = asset !== ["']btc["']/);
});
