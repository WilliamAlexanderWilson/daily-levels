const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const siteRoot = path.join(__dirname, "..", "site");

test("the public dashboard identifies William Wilson as its owner", () => {
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.match(html, /William Wilson's Range Desk/);
  assert.match(html, /by William Wilson/);
  assert.match(html, /<meta name="description" content="William Wilson's evidence-first live range dashboard/);
  assert.match(html, /<link rel="canonical" href="https:\/\/williamalexanderwilson\.github\.io\/daily-levels\/"/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="favicon\.svg"/);
  assert.match(html, /<a class="brand-mark" href="\.\/" aria-label="Range Desk home">/);
  assert.match(html, /<img src="favicon\.svg" width="42" height="42" alt=""/);
  assert.match(html, />Source code<\/a>/);
  assert.match(html, />Research notes<\/a>/);
  assert.equal(fs.existsSync(path.join(siteRoot, "favicon.svg")), true);
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
