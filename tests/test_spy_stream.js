const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("../site/spy-stream.js");

class FakeSocket {
  static latest;
  constructor(url) { this.url = url; this.handlers = {}; this.sent = []; FakeSocket.latest = this; }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  send(value) { this.sent.push(JSON.parse(value)); }
  emit(row) { this.handlers.message({ data: JSON.stringify([row]) }); }
  close() { this.handlers.close?.(); }
}
const now = Date.parse("2026-11-16T20:01:01Z");
const raw = { S: "SPY", t: "2026-11-16T20:00:00Z", o: 10, h: 11, l: 9, c: 10.01, v: 10 };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("SPY stream buffers bars during recovery and lets corrected stream values beat REST", async () => {
  let respond;
  const updates = [];
  const statuses = [];
  const client = createClient({ key: "test-key", secret: "test-secret", startTime: now / 1000 - 3600,
    WebSocket: FakeSocket, now: () => now, onBars: (update) => updates.push(update), onStatus: (state) => statuses.push(state),
    fetch: async (url, options) => {
      assert.equal(new URL(url).host, "data.alpaca.markets");
      assert.equal(url.includes("test-secret"), false);
      assert.equal(options.headers["APCA-API-SECRET-KEY"], "test-secret");
      return new Promise((resolve) => { respond = resolve; });
    },
  });
  client.start();
  const socket = FakeSocket.latest;
  socket.handlers.open();
  socket.emit({ T: "success", msg: "authenticated" });
  socket.emit({ T: "subscription", bars: ["SPY"] });
  socket.emit({ ...raw, T: "u", c: 10.8 });
  assert.equal(updates.length, 0);
  respond({ ok: true, json: async () => ({ bars: [raw], next_page_token: null }) });
  await nextTurn();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].bars[0].close, 10.8);
  assert.equal(updates[0].completedThrough, Date.parse(raw.t) / 1000 + 60);
  assert.equal(JSON.stringify(statuses).includes("test-secret"), false);
  client.stop();
});

test("stopping during recovery prevents stale callbacks and permanently clears the client", async () => {
  let respond;
  let updates = 0;
  const client = createClient({ key: "test", secret: "test", startTime: now / 1000 - 3600,
    WebSocket: FakeSocket, now: () => now, onBars: () => updates++,
    fetch: async () => new Promise((resolve) => { respond = resolve; }),
  });
  client.start();
  const socket = FakeSocket.latest;
  socket.emit({ T: "subscription", bars: ["SPY"] });
  client.stop();
  respond({ ok: true, json: async () => ({ bars: [raw] }) });
  await nextTurn();
  socket.emit({ ...raw, T: "b" });
  client.start();
  assert.equal(updates, 0);
  assert.equal(FakeSocket.latest, socket);
});

test("authentication failures never retry or surface server text containing credentials", () => {
  const statuses = [];
  const client = createClient({ key: "test", secret: "test-secret", startTime: 0,
    WebSocket: FakeSocket, onStatus: (state) => statuses.push(state),
  });
  client.start();
  FakeSocket.latest.emit({ T: "error", code: 406, msg: "test-secret" });
  assert.equal(statuses.at(-1).state, "error");
  assert.match(statuses.at(-1).detail, /one stream/);
  assert.equal(JSON.stringify(statuses).includes("test-secret"), false);
  client.stop();
});

test("denied REST history stops the client before claiming live synchronization", async () => {
  const statuses = [];
  let updates = 0;
  const client = createClient({ key: "test", secret: "test", startTime: 0, WebSocket: FakeSocket,
    onStatus: (state) => statuses.push(state), onBars: () => updates++,
    fetch: async () => ({ ok: false, status: 403 }),
  });
  client.start();
  FakeSocket.latest.emit({ T: "subscription", bars: ["SPY"] });
  await nextTurn();
  assert.equal(statuses.at(-1).state, "error");
  assert.equal(updates, 0);
  client.stop();
});

test("a slow REST response never promotes a candle that was forming at request time", async (t) => {
  let clock = Date.parse("2026-11-16T20:00:59Z");
  let respond;
  const updates = [];
  const client = createClient({ key: "test", secret: "test", startTime: now / 1000 - 3600,
    WebSocket: FakeSocket, now: () => clock, onBars: (update) => updates.push(update),
    fetch: async () => new Promise((resolve) => { respond = resolve; }),
  });
  t.after(() => client.stop());
  client.start();
  FakeSocket.latest.emit({ T: "subscription", bars: ["SPY"] });
  clock = Date.parse("2026-11-16T20:01:02Z");
  respond({ ok: true, json: async () => ({ bars: [{ ...raw, t: "2026-11-16T19:59:00Z" }, raw] }) });
  await nextTurn();
  assert.equal(updates[0].bars.length, 1);
  assert.equal(updates[0].completedThrough, Date.parse("2026-11-16T20:00:00Z") / 1000);
});

test("missing IEX minutes recover a confirmed boundary without fabricating minute candles", async (t) => {
  let clock = now;
  const updates = [];
  const client = createClient({ key: "test", secret: "test", startTime: now / 1000 - 3600,
    WebSocket: FakeSocket, now: () => clock, onBars: (update) => updates.push(update),
    fetch: async () => ({ ok: true, json: async () => ({ bars: [raw] }) }),
  });
  t.after(() => client.stop());
  client.start();
  FakeSocket.latest.emit({ T: "subscription", bars: ["SPY"] });
  await nextTurn();
  clock = Date.parse("2026-11-16T20:05:03Z");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(updates.at(-1).completedThrough, Date.parse("2026-11-16T20:05:00Z") / 1000);
  assert.equal(updates.at(-1).bars.length, 1);
});

test("a reconnect repairs missed corrections before resuming chart updates", async (t) => {
  let requests = 0;
  const updates = [];
  const states = [];
  const client = createClient({ key: "test", secret: "test", startTime: now / 1000 - 3600,
    WebSocket: FakeSocket, now: () => now, onBars: (update) => updates.push(update), onStatus: ({ state }) => states.push(state),
    fetch: async () => ({ ok: true, json: async () => ({ bars: [{ ...raw, c: ++requests === 1 ? 10.01 : 10.9 }] }) }),
  });
  t.after(() => client.stop());
  client.start();
  const first = FakeSocket.latest;
  first.emit({ T: "subscription", bars: ["SPY"] });
  await nextTurn();
  first.close();
  assert.equal(states.at(-1), "reconnecting");
  first.emit({ ...raw, T: "b", c: 10.5 });
  assert.equal(updates.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.notEqual(FakeSocket.latest, first);
  FakeSocket.latest.emit({ T: "subscription", bars: ["SPY"] });
  await nextTurn();
  assert.equal(updates.at(-1).bars[0].close, 10.9);
});

for (const symbol of ['SPY', 'QQQ', 'NVDA']) {
  test(`${symbol} receives after-hours candles and prices only for the subscribed symbol`, async () => {
    const updates = [], trades = [];
    const afterHours = Date.parse('2026-11-16T21:02:01Z');
    const client = createClient({key:'test',secret:'test',symbol,startTime:afterHours/1000-3600,
      WebSocket:FakeSocket, now:()=>afterHours, onBars:s=>updates.push(s), onTrade:t=>trades.push(t),
      fetch:async url=>{
        assert.equal(new URL(url).pathname, `/v2/stocks/${symbol}/bars`);
        return {ok:true,json:async()=>({bars:[{...raw,S:symbol,t:'2026-11-16T21:00:00Z'}]})};
      },
    });
    client.start();
    const socket=FakeSocket.latest;
    socket.emit({T:'success',msg:'authenticated'});
    assert.deepEqual(socket.sent.at(-1).bars,[symbol]);
    socket.emit({T:'subscription',bars:[symbol]});
    await nextTurn();
    socket.emit({...raw,T:'b',S:symbol,t:'2026-11-16T21:01:00Z'});
    socket.emit({T:'t',S:symbol,t:'2026-11-16T21:02:00Z',p:123.45});
    socket.emit({...raw,T:'b',S:'UNRELATED',t:'2026-11-16T21:01:00Z'});
    socket.emit({T:'t',S:'UNRELATED',t:'2026-11-16T21:02:00Z',p:999});
    assert.equal(updates.at(-1).bars.length,2);
    assert.equal(trades.length,1);
    assert.equal(trades[0].price,123.45);
    client.stop();
  });
}
