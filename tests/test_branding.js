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
  assert.match(source, /sourceUrl: "https:\/\/youtu\.be\/cOxjsDvGRTA"/);
  assert.doesNotMatch(source, /sourceLabel:\s*["']William Wilson/);
  assert.match(html, /Method source ↗/);
});
