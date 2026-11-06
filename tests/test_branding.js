const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const siteRoot = path.join(__dirname, "..", "site");

test("the public dashboard identifies William Wilson as its owner", () => {
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.match(html, /William Wilson's Range Desk/);
  assert.match(html, /by William Wilson/);
});

test("product branding stays separate from the range method provenance", () => {
  const source = fs.readFileSync(path.join(siteRoot, "range-decision.js"), "utf8");
  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  assert.match(source, /sourceLabel: "Sourced macro-range framework"/);
  assert.match(source, /sourceUrl: "#range-method-sources"/);
  assert.doesNotMatch(source, /sourceLabel:\s*["']William Wilson/);
  assert.match(html, /Method sources ↗/);
  for (const sourceId of ["cOxjsDvGRTA", "HBKEvXjDbS0", "v3fXVye-TVg"]) {
    assert.match(html, new RegExp(`https:\\/\\/youtu\\.be\\/${sourceId}`));
  }
  const app = fs.readFileSync(path.join(siteRoot, "app.js"), "utf8");
  assert.match(app, /range-method-sources["']\)\.hidden = asset !== ["']btc["']/);
});
