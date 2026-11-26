const { test, expect } = require("@playwright/test");

async function openDashboard(page) {
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.LightweightCharts = {};",
  }));
  await page.route("https://api.kraken.com/**", (route) => route.abort("internetdisconnected"));
  await page.goto("/#asset=btc&range=4h", { waitUntil: "domcontentloaded" });
}

async function installSpyChartStub(page) {
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      const priceScale = { applyOptions() {}, setAutoScale() {}, getVisibleRange() { return null; }, width() { return 50; } };
      const series = { setData(data) { if (data.length && 'open' in data[0]) window.__spyCandles = data; },
        priceScale() { return priceScale; }, createPriceLine() { return { applyOptions() {} }; },
        removePriceLine() {}, priceToCoordinate() { return null; } };
      const timeScale = { subscribeVisibleLogicalRangeChange() {}, fitContent() {}, getVisibleLogicalRange() { return null; } };
      window.LightweightCharts = {
        createChart() { return { addSeries() { return series; }, subscribeClick(handler) { window.__spyClick = handler; }, subscribeCrosshairMove() {}, timeScale() { return timeScale; } }; },
        createSeriesMarkers() { return { setMarkers(markers) { window.__spyMarkers = markers; } }; },
        CandlestickSeries: {}, HistogramSeries: {}, CrosshairMode: { Normal: 0 },
        LineStyle: { Dotted: 0, Dashed: 1, Solid: 2 }, PriceScaleMode: { Normal: 0 }
      };
    `,
  }));
}

async function expectBrand(page, asset, label) {
  await expect(page.locator("#brand-mark-img")).toHaveAttribute("src", `brand-${asset}.svg`);
  await expect(page.locator("#site-favicon")).toHaveAttribute("href", `brand-${asset}.svg`);
  await expect(page.locator(".brand-mark")).toHaveAttribute("aria-label", `${label} Range Desk home`);
  await expect(page).toHaveTitle(`${label} — William Wilson's Range Desk`);
}

async function dojiColorSummary(page) {
  return page.evaluate(() => {
    const candles = new Map((window.__spyCandles || []).map((bar) => [bar.time, bar]));
    const style = getComputedStyle(document.documentElement);
    const up = style.getPropertyValue("--support").trim();
    const down = style.getPropertyValue("--resistance").trim();
    const minutes = Number(document.querySelector("#spy-timeframe-select").value);
    const expectedStreaks = new Map();
    let previousTime = null;
    let previousUp = null;
    let streak = 0;
    for (const candle of candles.values()) {
      const isDoji = candle.high > candle.low
        && Math.abs(candle.close - candle.open) / (candle.high - candle.low) <= 0.1;
      if (!isDoji) { previousTime = null; streak = 0; continue; }
      const isUp = candle.close >= candle.open;
      streak = previousTime !== null && candle.time - previousTime > 0
        && candle.time - previousTime <= minutes * 60 && previousUp === isUp
        ? streak + 1 : 1;
      expectedStreaks.set(candle.time, streak);
      previousTime = candle.time;
      previousUp = isUp;
    }
    const markers = (window.__spyMarkers || []).filter((marker) => /^D\d+$/.test(marker.text));
    return {
      count: markers.length,
      colors: [...new Set(markers.map((marker) => marker.color))],
      wrongStreaks: markers.filter((marker) => marker.text !== `D${expectedStreaks.get(marker.time)}`),
      notDojis: markers.filter((marker) => {
        const candle = candles.get(marker.time);
        return !candle || candle.high <= candle.low
          || Math.abs(candle.close - candle.open) / (candle.high - candle.low) > 0.1;
      }),
      mismatches: markers.filter((marker) => {
        const candle = candles.get(marker.time);
        return !candle || marker.color !== (candle.close >= candle.open ? up : down);
      }),
    };
  });
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

test("SPY renders every published interval and keeps deep links on desktop and mobile", async ({ page }) => {
  await installSpyChartStub(page);
  await page.goto("/#asset=spy&range=15m&session=regular", { waitUntil: "domcontentloaded" });
  const select = page.locator("#spy-timeframe-select");
  await expect(select).toBeVisible();
  await expect(select.locator("option")).toHaveText(["1m", "5m", "10m", "15m", "20m", "30m", "1H", "4H"]);
  await expect.poll(() => page.evaluate(() => window.__spyCandles?.length || 0)).toBeGreaterThan(0);
  await expect(page.locator("#history-load-status")).toContainText("archive starts Jul 2020");
  for (const minutes of ["1", "5", "10", "15", "20", "30", "60", "240"]) {
    await select.selectOption(minutes);
    await expect(page).toHaveURL(new RegExp(`#asset=spy&range=${minutes}m&session=regular$`));
    const bars = await page.evaluate(() => window.__spyCandles || []);
    expect(bars.length, `${minutes}m chart has published bars`).toBeGreaterThan(0);
    expect(bars.every((bar, index) => index === 0 || bar.time > bars[index - 1].time)).toBe(true);
    if (["1", "5", "10"].includes(minutes)) {
      const markers = await page.evaluate(() => window.__spyMarkers || []);
      expect(markers.filter((marker) => /^D\d+$/.test(marker.text)).length,
        `${minutes}m chart has completed SPY doji markers`).toBeGreaterThan(0);
      const colors = await dojiColorSummary(page);
      expect(colors.wrongStreaks, `${minutes}m D labels match same-color streaks`).toEqual([]);
      expect(colors.mismatches,
        `${minutes}m doji D colors match the displayed Regular candles`).toEqual([]);
      expect(colors.notDojis,
        `${minutes}m D markers must be dojis on the displayed Regular candles`).toEqual([]);
      if (minutes === "1") expect(colors.colors).toHaveLength(2);
      await expect(page.locator("#doji-study-status")).toContainText(/completed Regular dojis/);
    }
  }
  await select.selectOption("1");
  await page.locator('[data-candle-style="heikin-ashi"]').click();
  const heikinAshiDojis = await dojiColorSummary(page);
  expect(heikinAshiDojis.count).toBeGreaterThan(0);
  expect(heikinAshiDojis.wrongStreaks, "HA D labels match same-color streaks").toEqual([]);
  expect(heikinAshiDojis.mismatches, "doji D colors match the displayed Heikin Ashi candles").toEqual([]);
  expect(heikinAshiDojis.notDojis, "D markers must be dojis on the displayed Heikin Ashi candles").toEqual([]);
  expect(heikinAshiDojis.colors).toHaveLength(2);
  await select.selectOption("240");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(select).toHaveValue("240");
  await page.locator('[data-asset="qqq"]').click();
  await expect(select.locator("option")).toHaveText(["10m", "15m", "20m", "30m"]);
  await expect(page.locator("#history-load-status")).toContainText("archive starts Jul 2020");
  expect(await page.evaluate(() => (window.__spyMarkers || []).some((marker) => /^D\d+$/.test(marker.text)))).toBe(false);
  await page.locator('[data-asset="nvda"]').click();
  await expect(page.locator("#history-load-status")).toContainText("archive starts Jul 2020");
  await page.locator('[data-asset="xau"]').click();
  await expect(select.locator("option")).toHaveText(["15m", "30m", "1H", "4H"]);
  await expect(page.locator("#history-load-status")).toContainText("archive starts Sep 2025");
  expect(await page.evaluate(() => (window.__spyMarkers || []).some((marker) => /^D\d+$/.test(marker.text)))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("selected doji panel explains actual counts and clears across chart views", async ({ page }) => {
  await installSpyChartStub(page);
  await page.route("**/data/spy_chart.json", async route => {
    const response = await route.fetch(), data = await response.json();
    const end = Math.floor(Date.now() / 60000) * 60 - 60;
    data.timeframes["1"] = [0, 1, 2].map(i => ({time:end - (2-i)*60,open:10,high:11,low:9,close:10.01}));
    data.generated_at_utc = new Date(end * 1000).toISOString();
    await route.fulfill({response,json:data});
  });
  let studyRequests = 0;
  page.on("request", (request) => { if (request.url().includes("spy_doji_context.json")) studyRequests += 1; });
  await page.goto("/#asset=spy&range=1m&session=regular", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#doji-latest")).toBeEnabled();
  expect(studyRequests).toBe(0);
  const selected = await page.evaluate(() => {
    const marker = window.__spyMarkers.find((item) => item.text === "D3");
    window.__spyClick({ time: marker.time, point: { x: 100, y: 100 } });
    return marker;
  });
  await expect(page.locator("#doji-context-results")).toBeVisible();
  await expect(page.locator("#doji-context-selection")).toContainText("D3 · 1m · Regular");
  await expect(page.locator("#doji-context-shape")).toContainText("body ≤ 10%");
  const expected = await page.evaluate(async (marker) => {
    const report = await (await fetch("data/spy_doji_context.json")).json();
    const bar = window.__spyCandles.find((item) => item.time === marker.time);
    const direction = bar.close >= bar.open ? "green" : "red";
    const row = report.rows.find((item) => item.timeframeMinutes === 1 && item.style === "regular" && item.direction === direction && item.streak === 3);
    const baseline = report.baselines.find((item) => item.timeframeMinutes === 1 && item.style === "regular" && item.direction === direction);
    return { pattern: `${row.nextCloseFavorable} / ${row.events}`, baseline: `${baseline.nextCloseFavorable.toLocaleString()} / ${baseline.events.toLocaleString()}` };
  }, selected);
  await expect(page.locator("#doji-pattern-count")).toContainText(expected.pattern);
  await expect(page.locator("#doji-baseline-count")).toContainText(expected.baseline);
  await page.locator("#doji-latest").click();
  await expect(page.locator("#doji-next")).toBeDisabled();
  const latest = await page.locator("#doji-context-selection").textContent();
  await page.locator("#doji-previous").click();
  await expect(page.locator("#doji-context-selection")).not.toHaveText(latest);
  await page.locator("#doji-next").click();
  await expect(page.locator("#doji-context-selection")).toHaveText(latest);
  await page.locator('[data-candle-style="heikin-ashi"]').click();
  await expect(page.locator("#doji-context-detail")).toBeHidden();
  await page.locator("#doji-latest").click();
  await expect(page.locator("#doji-context-selection")).toContainText("Heikin Ashi");
  await expect(page.locator("#doji-context-results")).toBeVisible();
  await page.locator("#spy-timeframe-select").selectOption("5");
  await expect(page.locator("#doji-context-detail")).toBeHidden();
  await page.locator('[data-asset="qqq"]').click();
  await expect(page.locator("#doji-context")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});

test("doji history retries, handles zero examples, and clears selection after an asset switch", async ({ page }) => {
  await installSpyChartStub(page);
  let failed = false;
  await page.route("**/data/spy_doji_context.json", async (route) => {
    if (!failed) { failed = true; await route.fulfill({ status: 503, body: "Unavailable" }); }
    else {
      const response = await route.fetch();
      const data = await response.json();
      data.rows.forEach((row) => Object.assign(row, { events: 0, nextCloseFavorable: 0,
        nextBarSameColor: 0, nextSameColorDoji: 0, nextCloseFavorableWilson95: null }));
      await route.fulfill({ response, json: data });
    }
  });
  await page.goto("/#asset=spy&range=1m&session=regular", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#doji-latest")).toBeEnabled();
  await page.locator("#doji-latest").click();
  await expect(page.locator("#doji-context-status")).toContainText("unavailable");
  await expect(page.locator("#doji-context-shape")).toContainText("Doji rule");
  await expect(page.locator("#doji-context-results")).toBeHidden();
  await page.locator("#doji-context-retry").click();
  await expect(page.locator("#doji-context-results")).toBeVisible();
  await expect(page.locator("#doji-pattern-count")).toHaveText("No eligible examples");
  await expect(page.locator("#doji-difference")).toHaveText("Unavailable");
  await page.locator('[data-asset="qqq"]').click();
  await expect(page.locator("#doji-context")).toBeHidden();
  await page.locator('[data-asset="spy"]').click();
  await expect(page.locator("#doji-latest")).toBeEnabled();
  await expect(page.locator("#doji-context-detail")).toBeHidden();
});

test("private SPY stream draws completed dojis promptly, applies corrections, and never saves credentials", async ({ page }) => {
  await installSpyChartStub(page);
  await page.route("**/data/spy_chart.json", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.generated_at_utc = "2026-11-16T20:30:00Z";
    for (const key of Object.keys(data.timeframes)) data.timeframes[key] = [
      {time: Date.parse("2026-11-16T19:01:00Z") / 1000, open:10, high:11, low:9, close:10.01},
      {time: Date.parse(data.generated_at_utc) / 1000, open:10, high:11, low:9, close:10.8},
    ];
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript(() => {
    window.__spyNow = Date.parse("2026-11-16T20:31:01Z");
    Date.now = () => window.__spyNow;
    window.WebSocket = class {
      constructor() { this.events = {}; window.__spySocket = this; queueMicrotask(() => this.events.open?.()); }
      addEventListener(name, handler) { this.events[name] = handler; }
      send(raw) {
        const message = JSON.parse(raw);
        if (message.action === "auth") queueMicrotask(() => this.emit({ T: "success", msg: "authenticated" }));
        if (message.action === "subscribe") queueMicrotask(() => this.emit({ T: "subscription", bars: ["SPY"] }));
      }
      emit(row) { this.events.message?.({ data: JSON.stringify([row]) }); }
      close() { this.events.close?.(); }
    };
  });
  await page.route("https://data.alpaca.markets/**", (route) => route.fulfill({ json: { bars: [], next_page_token: null } }));
  await page.goto("/#asset=spy&range=1m&session=regular", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#doji-latest")).toBeEnabled();
  await page.locator("#spy-live-connect summary").click();
  await page.locator("#spy-live-key").fill("private-test-key");
  await page.locator("#spy-live-secret").fill("private-test-secret");
  await page.locator('#spy-live-form button[type="submit"]').click();
  await expect(page.locator("#spy-live-status")).toContainText("waiting");
  await page.evaluate(() => {
    window.__spySocket.emit({ T: "b", S: "SPY", t: "2026-11-16T20:30:00Z", o: 10, h: 11, l: 9, c: 10.01, v: 10 });
    window.__spySocket.emit({ T: "t", S: "SPY", t: "2026-11-16T20:31:00.800Z", p: 10.02 });
  });
  await expect(page.locator("#spy-live-status")).toContainText("Live IEX");
  await expect(page.locator("#live-badge")).toContainText("Live IEX");
  await expect(page.locator("#spy-live-timing")).toContainText("1.00s after close");
  expect(await page.evaluate(() => window.__spyMarkers.some((marker) => marker.time === Date.parse("2026-11-16T20:31:00Z") / 1000 && marker.text === "D1"))).toBe(true);
  await expect(page.locator("#spy-live-key")).toHaveValue("");
  await expect(page.locator("#spy-live-secret")).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes("private-test"))).toBe(false);
  await page.locator("#candle-latest").click();
  await expect(page.locator("#candle-inspector-verdict")).toContainText("Doji shape:");
  await page.evaluate(() => window.__spySocket.emit({ T: "u", S: "SPY", t: "2026-11-16T20:30:00Z", o: 10, h: 11, l: 9, c: 10.9, v: 20 }));
  expect(await page.evaluate(() => window.__spyMarkers.some((marker) => marker.time === Date.parse("2026-11-16T20:31:00Z") / 1000))).toBe(false);
  await expect(page.locator("#candle-inspector-verdict")).toContainText("Not marked:");
  await expect(page.locator("#doji-context-results")).toBeHidden();
  await page.locator("#spy-timeframe-select").selectOption("5");
  await page.evaluate(() => {
    window.__spyNow = Date.parse("2026-11-16T20:35:01Z");
    window.__spySocket.emit({ T: "b", S: "SPY", t: "2026-11-16T20:34:00Z", o: 10.9, h: 11, l: 9, c: 10.01, v: 10 });
  });
  expect(await page.evaluate(() => window.__spyMarkers.some((marker) => marker.time === Date.parse("2026-11-16T20:35:00Z") / 1000 && marker.text === "D1"))).toBe(true);
  await expect(page.locator("#spy-live-timing")).toContainText("1.00s after close");
  await page.locator("#spy-live-disconnect").click();
  await expect(page.locator("#spy-live-status")).toContainText("disconnected");
  await expect(page.locator("#live-badge")).toContainText("last mark");
  const order = await page.evaluate(() => {
    const chart = document.querySelector("#chart-container").getBoundingClientRect();
    const context = document.querySelector("#doji-context").getBoundingClientRect();
    return context.top >= chart.bottom;
  });
  expect(order).toBe(true);
  await page.locator('[data-asset="qqq"]').click();
  await expect(page.locator("#spy-live-controls")).toBeVisible();
  await expect(page.locator("#spy-live-title")).toContainText("QQQ");
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


test("SPY inspector explains the borderline 15m candle and every selected shape", async ({ page }) => {
  await installSpyChartStub(page);
  await page.route("**/data/spy_chart.json", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.generated_at_utc = "2026-11-16T18:00:00Z";
    data.timeframes["15"] = [
      { time: 1794849300, open: 743, high: 744, low: 742, close: 743 },
      { time: 1794850200, open: 743, high: 743, low: 743, close: 743 },
      { time: 1794851100, open: 743.39, high: 743.82, low: 742.93, close: 743.30 },
      { time: 1794852000, open: 743, high: 744, low: 742, close: 742.5 },
      { time: 1794852900, open: 743, high: 744, low: 742, close: 743 },
    ];
    await route.fulfill({ response, json: data });
  });
  await page.goto("/#asset=spy&range=15m&session=regular", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#candle-latest")).toBeEnabled();
  await page.evaluate(() => window.__spyClick({ time: Date.parse("2026-11-16T17:45:00Z") / 1000 }));
  await expect(page.locator("#candle-inspector-prices")).toContainText("Open 743.3900");
  await expect(page.locator("#candle-inspector-verdict")).toHaveText("Not marked: 10.1124% > 10%.");
  await expect(page.locator("#doji-context-selection")).toContainText("15m · Regular · closes Nov 16, 2026, 11:45 AM CST · Completed");
  await expect(page.locator("#doji-context-results")).toBeHidden();
  await page.evaluate(() => window.__spyClick({ time: 1794850200 }));
  await expect(page.locator("#candle-inspector-verdict")).toHaveText("Not marked: no price range to measure.");
  await page.locator("#doji-latest").click();
  await expect(page.locator("#doji-context-results")).toBeVisible();
  await expect(page.locator("#candle-inspector-verdict")).toContainText("Doji shape:");
  await page.locator("#candle-latest").click();
  await expect(page.locator("#candle-inspector-verdict")).toContainText("awaiting candle completion");
  await expect(page.locator("#doji-context-results")).toBeHidden();
  await page.locator('[data-candle-style="heikin-ashi"]').click();
  await expect(page.locator("#doji-context-detail")).toBeHidden();
  await page.locator("#candle-latest").click();
  await expect(page.locator("#candle-inspector-prices")).toContainText("Derived Heikin Ashi prices");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});


test("successive marker panel counts intervening candles, explains boundaries, and retries history", async ({ page }) => {
  await installSpyChartStub(page);
  await page.route("**/data/spy_chart.json", async (route) => {
    const response = await route.fetch(), data = await response.json();
    const start = Date.parse("2026-11-16T15:00Z") / 1000;
    data.generated_at_utc = "2026-11-16T16:00Z";
    data.timeframes["5"] = [99.5,100,95,100.5,95,100.5,95,100.5,95,100.5].map((close,i)=>({time:start+i*300,open:100,high:110,low:90,close}));
    await route.fulfill({ response, json:data });
  });
  let fail = true;
  await page.route("**/data/spy_marker_context.json", async route => {
    if (fail) {fail=false;await route.fulfill({status:503,body:"Unavailable"});}
    else await route.continue();
  });
  await page.goto("/#asset=spy&range=5m&session=regular", {waitUntil:"domcontentloaded"});
  await expect(page.locator("#marker-run-heading")).toHaveText("Green marker run: 5");
  await expect(page.locator("#marker-run-detail")).toContainText("1/5 flat dojis");
  await expect(page.locator("#marker-run-frequency")).toContainText("unavailable");
  await page.locator("#marker-run-retry").click();
  await expect(page.locator("#marker-run-frequency")).toContainText("After 5 green markers");
  await expect(page.locator("#marker-run-baseline")).toContainText("Baseline after any green marker");
  await expect(page.locator("#marker-run-price")).toContainText("Real close higher 3 candles later");
  await page.locator(".marker-run-panel details summary").click();
  await expect(page.locator("#marker-forward-status")).toContainText("Nov 17, 2026, 8:30 AM CST");
  await page.evaluate(()=>window.__spyClick({time:Date.parse("2026-11-16T15:00Z")/1000}));
  await expect(page.locator("#marker-run-heading")).toHaveText("Red marker run: at least 1");
  await expect(page.locator("#marker-run-frequency")).toContainText("no exact-run comparison");
  await expect(page.locator("#marker-run-baseline")).toBeEmpty();
  await page.locator("#candle-latest").click();
  await expect(page.locator("#marker-run-heading")).toHaveText("Green marker run: 5");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.locator('[data-asset="qqq"]').click();
  await expect(page.locator(".marker-run-panel")).toBeHidden();
});

test('SPY defaults to real extended-hours history and can return to regular research', async ({page}) => {
  await installSpyChartStub(page);
  await page.goto('/#asset=spy&range=1m', {waitUntil:'domcontentloaded'});
  await expect(page.locator('#spy-session-select')).toHaveValue('extended');
  await expect(page.locator('#doji-latest')).toBeEnabled();
  expect(await page.evaluate(()=>window.__spyCandles.some(bar=>{
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(new Date((bar.time-60)*1000)).map(p=>[p.type,p.value]));
    const minute=Number(parts.hour)*60+Number(parts.minute);
    return minute<570||minute>=960;
  }))).toBe(true);
  await page.locator('#doji-latest').click();
  await expect(page.locator('#doji-context-results')).toBeHidden();
  await page.locator('#spy-session-select').selectOption('regular');
  await expect(page.locator('#doji-context-detail')).toBeHidden();
  await expect(page.locator('#doji-latest')).toBeEnabled();
  await page.locator('#doji-latest').click();
  await expect(page.locator('#doji-context-results')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

for (const asset of ['spy','qqq','nvda']) {
  test(`${asset} private feed draws after-hours prices and completed candles`, async ({page})=>{
    await installSpyChartStub(page);
    await page.route(`**/data/${asset === 'spy' ? 'spy_extended' : asset}_chart.json`, async route=>{
      const response=await route.fetch(), data=await response.json();
      data.generated_at_utc='2026-11-16T21:00:00Z';
      for(const key of Object.keys(data.timeframes)) data.timeframes[key]=[{time:Date.parse(data.generated_at_utc)/1000,open:100,high:101,low:99,close:100}];
      await route.fulfill({response,json:data});
    });
    await page.addInitScript(()=>{
      Date.now=()=>Date.parse('2026-11-16T21:10:01Z');
      window.WebSocket=class {
        constructor(){this.handlers={};window.__equitySocket=this;queueMicrotask(()=>this.handlers.open?.());}
        addEventListener(name,fn){this.handlers[name]=fn;}
        send(raw){const message=JSON.parse(raw);if(message.action==='auth')queueMicrotask(()=>this.emit({T:'success',msg:'authenticated'}));if(message.action==='subscribe'){this.symbol=message.bars[0];queueMicrotask(()=>this.emit({T:'subscription',bars:message.bars}));}}
        emit(row){this.handlers.message?.({data:JSON.stringify([row])});}
        close(){this.closed=true;this.handlers.close?.();}
      };
    });
    await page.route('https://data.alpaca.markets/**', route=>route.fulfill({json:{bars:[{t:'2026-11-16T21:00:00Z',o:100,h:102,l:99,c:101,v:10}]}}));
    await page.goto(`/#asset=${asset}&range=10m`,{waitUntil:'domcontentloaded'});
    await expect(page.locator('#spy-live-title')).toContainText(asset.toUpperCase());
    await expect.poll(()=>page.evaluate(()=>window.__spyCandles?.length||0)).toBeGreaterThan(0);
    await page.locator('#spy-live-connect summary').click();
    await page.locator('#spy-live-key').fill('test-key');
    await page.locator('#spy-live-secret').fill('test-secret');
    await page.locator('#spy-live-form button[type="submit"]').click();
    await expect(page.locator('#spy-live-status')).toContainText('waiting');
    await page.evaluate(()=>{
      const socket=window.__equitySocket;
      socket.emit({T:'b',S:socket.symbol,t:'2026-11-16T21:09:00Z',o:101,h:104,l:100,c:103,v:10});
      socket.emit({T:'t',S:socket.symbol,t:'2026-11-16T21:10:00.800Z',p:103.5});
    });
    await expect(page.locator('#price-label')).toHaveText('103.5');
    await expect(page.locator('#live-badge')).toContainText('Live IEX');
    expect(await page.evaluate(()=>window.__spyCandles.at(-1))).toMatchObject({time:Date.parse('2026-11-16T21:10:00Z')/1000,open:100,high:104,low:99,close:103});
    await page.locator('[data-asset="xau"]').click();
    expect(await page.evaluate(()=>window.__equitySocket.closed)).toBe(true);
    await expect(page.locator('#live-badge')).toBeHidden();
    expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]).includes('test-secret'))).toBe(false);
  });
}
