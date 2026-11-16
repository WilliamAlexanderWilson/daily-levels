(function (root, factory) {
  const live = typeof module === "object" && module.exports ? require("./spy-live.js") : root.SpyLive;
  const api = factory(live);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SpyStream = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Live) {
  "use strict";

  // This client only calls Alpaca's market-data hosts. Credentials stay in
  // memory and are never returned, logged, placed in URLs, or persisted.
  function createClient({ key, secret, ...options }) {
    if (!key || !secret || !Number.isFinite(options.startTime)) throw new Error("Market-data credentials and a history start are required");
    const Fetch = options.fetch || globalThis.fetch;
    const Socket = options.WebSocket || globalThis.WebSocket;
    const now = options.now || Date.now;
    const onStatus = options.onStatus || (() => {});
    const onBars = options.onBars || (() => {});
    const onTrade = options.onTrade || (() => {});
    let socket = null;
    let generation = 0;
    let stopped = true;
    let synced = false;
    let subscribed = false;
    let retry = null;
    let watchdog = null;
    let controller = null;
    let lastDataAt = null;
    let lastReceiptAt = null;
    let attempts = 0;
    let book = [];
    let buffered = [];
    let verifiedThrough = 0;

    function status(state, detail) { onStatus({ state, detail, lastDataAt }); }
    function publish(source = "history", barTime = null) {
      if (!synced || !book.length) return;
      onBars({ bars: book.slice(), completedThrough: Math.max(verifiedThrough, book[book.length - 1].time),
        coverageStart: options.startTime, receivedAt: now(), source, barTime });
    }

    async function backfill(token) {
      if (controller) return;
      synced = false;
      buffered = [];
      status("syncing", "Loading missed SPY minutes");
      const endTime = now();
      const completedEnd = Math.floor(endTime / 60000) * 60;
      const collected = [];
      const seenTokens = new Set();
      let pageToken = null;
      controller = new AbortController();
      const aborter = controller;
      const timeout = setTimeout(() => aborter.abort(), 15000);
      try {
        do {
          const url = new URL(Live.REST_URL);
          url.search = new URLSearchParams({ timeframe: "1Min", feed: "iex", adjustment: "raw",
            start: new Date(options.startTime * 1000).toISOString(),
            end: new Date(endTime).toISOString(), limit: "10000",
            ...(pageToken ? { page_token: pageToken } : {}) }).toString();
          const response = await Fetch(url.toString(), {
            headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
            signal: aborter.signal, cache: "no-store",
          });
          if (response.status === 401 || response.status === 403) {
            stop();
            status("error", "Alpaca denied minute-history access; check credentials and data permissions");
            return;
          }
          if (!response.ok) throw new Error(`Market-data history HTTP ${response.status}`);
          const payload = await response.json();
          if (!Array.isArray(payload.bars)) throw new Error("Invalid minute history");
          for (const row of payload.bars) {
            const bar = Live.normalizeBar(row);
            if (!bar) throw new Error("Invalid minute history");
            if (bar.time <= completedEnd) collected.push(bar);
          }
          pageToken = payload.next_page_token;
          if (pageToken && seenTokens.has(pageToken)) throw new Error("Repeated minute-history page");
          if (pageToken) seenTokens.add(pageToken);
          if (seenTokens.size > 100) throw new Error("Minute-history page limit reached");
        } while (pageToken && token === generation && !stopped);
        if (token !== generation || stopped) return;
        book = Live.mergeBars(collected, buffered);
        verifiedThrough = completedEnd;
        buffered = [];
        synced = true;
        attempts = 0;
        status(lastDataAt !== null && now() - lastDataAt <= 10000 ? "live" : "waiting", "IEX connected; completed candles update each minute");
        publish();
      } catch (_) {
        if (token === generation && !stopped) {
          status("syncing", "SPY history recovery failed; retrying before showing live candles");
          socket?.close();
        }
      } finally {
        clearTimeout(timeout);
        if (controller === aborter) controller = null;
      }
    }

    function connect() {
      if (stopped) return;
      const token = ++generation;
      synced = false;
      subscribed = false;
      verifiedThrough = 0;
      buffered = [];
      lastReceiptAt = now();
      status("connecting", "Connecting to Alpaca IEX");
      let connection;
      try { connection = new Socket(Live.STREAM_URL); }
      catch (_) { stop(); status("error", "Could not open the market-data connection"); return; }
      socket = connection;
      connection.addEventListener("open", () => {
        if (token !== generation || stopped) return connection.close();
        connection.send(JSON.stringify({ action: "auth", key, secret }));
      });
      connection.addEventListener("message", (event) => {
        if (token !== generation || stopped) return;
        lastReceiptAt = now();
        for (const row of Live.parseMessages(event.data)) {
          if (row.T === "error") {
            const detail = row.code === 406 ? "Alpaca allows only one stream for this account; close the other connection"
              : row.code === 409 ? "This account does not have access to the selected market-data feed"
                : "Alpaca rejected the connection; check market-data access and credentials";
            stop();
            status("error", detail);
            return;
          }
          if (row.T === "success" && row.msg === "authenticated") {
            connection.send(JSON.stringify({ action: "subscribe", bars: ["SPY"], updatedBars: ["SPY"], trades: ["SPY"] }));
          }
          if (row.T === "subscription" && row.bars?.includes("SPY") && !subscribed) {
            subscribed = true;
            backfill(token);
          }
          if (row.S !== "SPY") continue;
          if (row.T === "t" && Number.isFinite(row.p) && row.p > 0 && Number.isFinite(Date.parse(row.t))) {
            const time = Date.parse(row.t);
            if (time <= now() + 1000 && (lastDataAt === null || time >= lastDataAt)) {
              lastDataAt = time;
              if (synced) {
                onTrade({ price: row.p, time, receivedAt: now() });
                status(now() - time <= 10000 ? "live" : "stale", "Single-exchange trades; candles update each minute");
              }
            }
          }
          if (row.T === "b" || row.T === "u") {
            const bar = Live.normalizeBar(row);
            if (!bar) { status("syncing", "Invalid SPY minute received; recovering history"); connection.close(); return; }
            if (bar.time > now() / 1000) continue;
            if (!synced) buffered = Live.mergeBars(buffered, [bar]);
            else {
              book = Live.mergeBars(book, [bar]);
              verifiedThrough = Math.max(verifiedThrough, bar.time);
              publish(row.T === "u" ? "correction" : "bar", bar.time);
            }
          }
        }
      });
      connection.addEventListener("error", () => connection.close());
      connection.addEventListener("close", () => {
        if (token !== generation || stopped) return;
        synced = false;
        subscribed = false;
        controller?.abort();
        status("reconnecting", "SPY disconnected; candles will recover before resuming");
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 30000));
      });
    }

    function start() {
      if (!stopped || !key || !secret) return;
      stopped = false;
      connect();
      watchdog = setInterval(() => {
        if (stopped) return;
        const boundary = Math.floor(now() / 60000) * 60;
        const marketOpen = Boolean(Live.bucketForMinute(boundary + 60, 1));
        if (synced && (lastDataAt === null || now() - lastDataAt > 10000)) {
          status(marketOpen ? "stale" : "closed", marketOpen
            ? "No recent IEX trade; the displayed price is the last received mark"
            : "Regular session closed; waiting for new market data");
        }
        // No-trade IEX minutes have no bar event. A REST recovery after three
        // seconds confirms the boundary so longer intervals can still close.
        if (subscribed && verifiedThrough < boundary && now() - boundary * 1000 >= 3000
            && Live.bucketForMinute(boundary, 1)) backfill(generation);
        if (marketOpen && lastReceiptAt !== null && now() - lastReceiptAt > 90000) socket?.close();
      }, 1000);
    }

    function stop() {
      stopped = true;
      generation += 1;
      synced = false;
      clearTimeout(retry);
      clearInterval(watchdog);
      controller?.abort();
      socket?.close();
      socket = null;
      key = "";
      secret = "";
      buffered = [];
      book = [];
    }

    return { start, stop };
  }

  return { createClient };
});
