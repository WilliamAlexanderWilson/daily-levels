(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AssetBrand = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const BRANDS = Object.freeze({
    btc: Object.freeze({ label: "Bitcoin", mark: "brand-btc.svg" }),
    eth: Object.freeze({ label: "Ethereum", mark: "brand-eth.svg" }),
    spy: Object.freeze({ label: "SPY", mark: "brand-spy.svg" }),
    qqq: Object.freeze({ label: "QQQ", mark: "brand-qqq.svg" }),
    nvda: Object.freeze({ label: "NVIDIA", mark: "brand-nvda.svg" }),
  });

  function forAsset(asset) {
    return BRANDS[asset] || BRANDS.btc;
  }

  function apply(doc, asset) {
    const brand = forAsset(asset);
    const mark = doc.getElementById("brand-mark-img");
    const home = mark && mark.closest(".brand-mark");
    const favicon = doc.getElementById("site-favicon");
    if (mark) mark.src = brand.mark;
    if (home) home.setAttribute("aria-label", `${brand.label} Range Desk home`);
    if (favicon) favicon.href = brand.mark;
    doc.title = `${brand.label} — William Wilson's Range Desk`;
    return brand;
  }

  return { BRANDS, forAsset, apply };
});
