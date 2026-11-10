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
  await expect(page).toHaveURL(/#asset=spy&range=4h$/);
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
