import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const LIVE_URL = process.env.RANGE_DESK_CAPTURE_URL || "https://williamalexanderwilson.github.io/daily-levels/#asset=btc&range=4h";
const DASHBOARD_PATH = "docs/assets/range-desk-dashboard.jpg";
const SOCIAL_PATH = "site/social-preview.jpg";

await mkdir("docs/assets", { recursive: true });

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(LIVE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".site-header").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const price = document.getElementById("price-label");
    return price && price.textContent.trim() !== "—";
  }, { timeout: 30_000 });
  await page.waitForTimeout(2_000);
  await page.addStyleTag({
    content: `
      * { caret-color: transparent !important; }
      html { scrollbar-width: none; }
      ::-webkit-scrollbar { display: none; }
    `,
  });
  await page.screenshot({
    path: DASHBOARD_PATH,
    type: "jpeg",
    quality: 90,
    fullPage: false,
  });
  await context.close();

  const dashboard = (await readFile(DASHBOARD_PATH)).toString("base64");
  const social = await browser.newPage({ viewport: { width: 1280, height: 640 } });
  await social.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <style>
          * { box-sizing: border-box; }
          html, body { width: 1280px; height: 640px; margin: 0; overflow: hidden; }
          body {
            display: grid;
            grid-template-columns: 520px 1fr;
            color: #f2f4ef;
            background:
              radial-gradient(circle at 10% 10%, rgba(82, 171, 130, .16), transparent 34%),
              #0c1013;
            font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .copy {
            display: flex;
            flex-direction: column;
            justify-content: center;
            padding: 68px 34px 60px 72px;
          }
          .eyebrow {
            margin: 0 0 20px;
            color: #84c9a7;
            font: 750 15px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
            letter-spacing: .16em;
            text-transform: uppercase;
          }
          h1 { margin: 0; font-size: 68px; line-height: .95; letter-spacing: -.055em; }
          .owner { margin: 14px 0 0; color: #b8c0b8; font-size: 19px; font-weight: 650; }
          .summary { margin: 38px 0 0; max-width: 390px; color: #d7dcd5; font-size: 24px; line-height: 1.34; }
          .markets { display: flex; gap: 10px; margin-top: 34px; }
          .markets span {
            padding: 9px 14px;
            border: 1px solid #35423b;
            border-radius: 999px;
            color: #dce2dc;
            background: rgba(16, 22, 26, .72);
            font-size: 15px;
            font-weight: 750;
            letter-spacing: .05em;
          }
          .product {
            position: relative;
            margin: 54px 0 54px 18px;
            overflow: hidden;
            border: 1px solid #37453d;
            border-right: 0;
            border-radius: 22px 0 0 22px;
            background: #0b0f12;
            box-shadow: 0 34px 90px rgba(0, 0, 0, .46);
          }
          .product::before {
            position: absolute;
            z-index: 2;
            inset: 0;
            content: "";
            box-shadow: inset 70px 0 80px rgba(12, 16, 19, .5);
            pointer-events: none;
          }
          .product img {
            width: 970px;
            height: 606px;
            object-fit: cover;
            object-position: 8% top;
            transform: translate(-70px, -37px) scale(.98);
            transform-origin: top left;
            filter: saturate(.94) contrast(1.03);
          }
          .proof {
            position: absolute;
            z-index: 3;
            right: 28px;
            bottom: 24px;
            padding: 10px 14px;
            border: 1px solid #466254;
            border-radius: 999px;
            color: #a8d7bf;
            background: rgba(12, 16, 19, .88);
            font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
            letter-spacing: .04em;
          }
        </style>
      </head>
      <body>
        <section class="copy">
          <p class="eyebrow">William Wilson · Market research</p>
          <h1>Range Desk</h1>
          <p class="owner">Built by William Wilson</p>
          <p class="summary">Price location, confirmation, and risk—without turning uncertainty into a signal.</p>
          <div class="markets" aria-label="Markets"><span>BTC</span><span>ETH</span><span>SPY</span><span>QQQ</span><span>NVDA</span></div>
        </section>
        <section class="product" aria-label="Range Desk dashboard preview">
          <img src="data:image/jpeg;base64,${dashboard}" alt="" />
          <span class="proof">LIVE DASHBOARD · OPEN RESEARCH</span>
        </section>
      </body>
    </html>
  `, { waitUntil: "load" });
  await social.screenshot({
    path: SOCIAL_PATH,
    type: "jpeg",
    quality: 90,
  });
  await social.close();
} finally {
  await browser.close();
}

console.log(`Captured ${DASHBOARD_PATH} and ${SOCIAL_PATH}`);
