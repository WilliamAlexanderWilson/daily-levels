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

test("the visible range label uses Range Desk branding, not another creator's name", () => {
  const source = fs.readFileSync(path.join(siteRoot, "range-decision.js"), "utf8");
  assert.match(source, /William Wilson Range Desk · sourced macro range/);
  assert.doesNotMatch(source, /sourceLabel:\s*["']Mathieu/);
});
