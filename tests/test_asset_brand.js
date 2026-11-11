const test = require("node:test");
const assert = require("node:assert/strict");
const AssetBrand = require("../site/asset-brand.js");

function fakeDocument() {
  const home = {
    label: "",
    setAttribute(name, value) {
      if (name === "aria-label") this.label = value;
    },
  };
  const mark = { src: "", closest: () => home };
  const favicon = { href: "" };
  return {
    title: "",
    mark,
    favicon,
    home,
    getElementById(id) {
      if (id === "brand-mark-img") return mark;
      if (id === "site-favicon") return favicon;
      return null;
    },
  };
}

for (const [asset, label] of [["btc", "Bitcoin"], ["eth", "Ethereum"], ["spy", "SPY"], ["qqq", "QQQ"], ["nvda", "NVIDIA"], ["xau", "XAU Gold"]]) {
  test(`${asset.toUpperCase()} selects only its own chart brand`, () => {
    const doc = fakeDocument();
    const brand = AssetBrand.apply(doc, asset);
    assert.equal(brand.mark, `brand-${asset}.svg`);
    assert.equal(doc.mark.src, `brand-${asset}.svg`);
    assert.equal(doc.favicon.href, `brand-${asset}.svg`);
    assert.equal(doc.home.label, `${label} Range Desk home`);
    assert.equal(doc.title, `${label} — William Wilson's Range Desk`);
  });
}

test("an unknown asset fails safely to Bitcoin", () => {
  assert.equal(AssetBrand.forAsset("unknown"), AssetBrand.BRANDS.btc);
});
