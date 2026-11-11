const { test, expect } = require("@playwright/test");

async function openDashboard(page) {
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.LightweightCharts = {};",
  }));
  await page.route("https://api.kraken.com/**", (route) => route.abort("internetdisconnected"));
  await page.goto("/#asset=btc&range=4h", { waitUntil: "domcontentloaded" });
}

async function expectBrand(page, asset, label) {
  await expect(page.locator("#brand-mark-img")).toHaveAttribute("src", `brand-${asset}.svg`);
  await expect(page.locator("#site-favicon")).toHaveAttribute("href", `brand-${asset}.svg`);
  await expect(page.locator(".brand-mark")).toHaveAttribute("aria-label", `${label} Range Desk home`);
  await expect(page).toHaveTitle(`${label} — William Wilson's Range Desk`);
}

test("the active market controls the visible brand and browser identity", async ({ page }) => {
  await openDashboard(page);
  await expectBrand(page, "btc", "Bitcoin");

  await page.locator('[data-asset="eth"]').click();
  await expectBrand(page, "eth", "Ethereum");
  await expect(page).toHaveURL(/#asset=eth&range=4h$/);

  await page.locator('[data-asset="spy"]').click();
  await expectBrand(page, "spy", "SPY");
  await expect(page).toHaveURL(/#asset=spy&range=15m$/);

  await page.locator('[data-asset="qqq"]').click();
  await expectBrand(page, "qqq", "QQQ");
  await expect(page.locator("#subtitle")).toContainText("batch data");

  await page.locator('[data-asset="nvda"]').click();
  await expectBrand(page, "nvda", "NVIDIA");
  await expect(page.locator("#subtitle")).toContainText("no live signal");

  await page.locator('[data-asset="xau"]').click();
  await expectBrand(page, "xau", "XAU Gold");
  await expect(page.locator("#subtitle")).toContainText("Gold benchmark");
  await expect(page).toHaveURL(/#asset=xau&range=15m$/);
});

test("a stale XAU batch identifies its age without overflowing the page", async ({ page }) => {
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      const priceScale = { applyOptions() {}, setAutoScale() {}, getVisibleRange() { return null; }, width() { return 50; } };
      const series = { setData() {}, priceScale() { return priceScale; }, createPriceLine() { return { applyOptions() {} }; },
        removePriceLine() {}, priceToCoordinate() { return null; } };
      const timeScale = { subscribeVisibleLogicalRangeChange() {}, fitContent() {}, getVisibleLogicalRange() { return null; } };
      window.LightweightCharts = {
        createChart() { return { addSeries() { return series; }, subscribeClick() {}, subscribeCrosshairMove() {}, timeScale() { return timeScale; } }; },
        createSeriesMarkers() { return { setMarkers() {} }; },
        CandlestickSeries: {}, HistogramSeries: {}, CrosshairMode: { Normal: 0 },
        LineStyle: { Dotted: 0, Dashed: 1, Solid: 2 }, PriceScaleMode: { Normal: 0 }
      };
    `,
  }));
  await page.route("**/data/xau_chart.json", async (route) => {
    const response = await route.fetch();
    const chart = await response.json();
    chart.generated_at_utc = new Date(Date.now() - 19 * 3_600_000).toISOString();
    await route.fulfill({ response, json: chart });
  });
  await page.goto("/#asset=xau&range=15m", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#generated-label")).toContainText("XAU batch published");
  await expect(page.locator("#stale-banner")).toContainText("XAU batch data was published 19 hours ago");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("chart timestamps use Dallas 12-hour time and follow daylight saving", async ({ page }) => {
  await openDashboard(page);
  const labels = await page.evaluate(() => ({
    winter: window.ChartTime.formatDallasAxisTick(Date.parse("2026-11-08T16:00:00Z") / 1000, 3),
    summer: window.ChartTime.formatDallasAxisTick(Date.parse("2026-07-08T16:00:00Z") / 1000, 3),
    hover: window.ChartTime.formatDallasCrosshair(Date.parse("2026-11-08T16:00:00Z") / 1000),
    daily: window.ChartTime.formatDallasCrosshair("2024-10-01"),
  }));
  expect(labels.winter).toBe("10 AM");
  expect(labels.summer).toBe("11 AM");
  expect(labels.hover).toContain("10:00 AM CST");
  expect(labels.daily).toBe("Oct 1, 2024");
});

test("the professional shell remains usable at its target viewport", async ({ page }, testInfo) => {
  await openDashboard(page);
  await expect(page.locator(".site-header")).toBeVisible();
  await expect(page.locator("#asset-toggle")).toBeVisible();
  await expect(page.locator("#chart-container")).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(hasHorizontalOverflow).toBe(false);

  if (testInfo.project.name === "mobile-chromium") {
    await expect(page.locator(".brand-purpose")).toBeHidden();
    await expect(page.locator(".mobile-jump-nav")).toBeVisible();
    const mark = await page.locator(".brand-mark").boundingBox();
    expect(mark.width).toBeGreaterThanOrEqual(38);
    expect(mark.height).toBeGreaterThanOrEqual(38);
  }
});
