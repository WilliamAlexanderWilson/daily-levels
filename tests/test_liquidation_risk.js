const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRiskRows, opacityForRelative, smoothValues } = require("../site/liquidation-risk.js");

test("smoothValues averages neighboring bins", () => {
  assert.deepEqual(smoothValues([0, 1, 0], 1), [0.5, 1 / 3, 0.5]);
});

test("risk remains normalized against the global model peak", () => {
  const rows = buildRiskRows([
    { long_intensity: 1, short_intensity: 0 },
    { long_intensity: 0.08, short_intensity: 0 },
  ], { smoothingRadius: 0, threshold: 0.8 });

  assert.equal(rows[0].relative, 1);
  assert.equal(rows[0].significant, true);
  assert.equal(rows[1].relative, 0.08);
  assert.equal(rows[1].significant, false);
});

test("risk side uses the stronger modeled intensity", () => {
  const rows = buildRiskRows([
    { long_intensity: 0.2, short_intensity: 0.7 },
  ], { smoothingRadius: 0 });
  assert.equal(rows[0].side, "short");
});

test("opacity hides noise and preserves hotspot contrast", () => {
  assert.equal(opacityForRelative(0.79), 0);
  assert.equal(opacityForRelative(0.8), 0);
  assert.ok(opacityForRelative(0.9) > 0);
  assert.equal(opacityForRelative(1), 0.32);
});

test("empty and zero-intensity models render no rows", () => {
  assert.deepEqual(buildRiskRows([]), []);
  assert.deepEqual(buildRiskRows([{ long_intensity: 0, short_intensity: 0 }]), []);
});
