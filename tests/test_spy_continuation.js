const test = require('node:test');
const assert = require('node:assert/strict');
const { study } = require('../scripts/study-spy-doji-continuation.js');
const { analyze } = require('../scripts/analyze-spy-doji-streaks.js');
const start = Date.parse('2026-11-16T15:00Z') / 1000;
const bar = (i, close = 101) => ({ time: start + i * 300, open:100, high:110, low:90, close });
test('exact streak positions separate next candle color from another doji', () => {
  const bars=[bar(0),bar(1),bar(2),bar(3,95),bar(5),bar(6,105)];
  const rows=study(bars,5,'regular',bars.at(-1).time);
  const row=(direction,streak)=>rows.find(r=>r.period==='all'&&r.direction===direction&&r.streak===streak);
  assert.equal(row('green',3).n,1);
  assert.equal(row('green',3).realSameColor,0);
  assert.equal(row('green',2).nextSameColorDoji,1);
  assert.equal(row('green',1).n,2);
  assert.equal(row('green',1).nextSameColorDoji,1);
  assert.equal(row('red','ordinary').n,0); // Missing interval excluded.
});
test('completion cutoff excludes the uncompleted outcome; invalid bars fail', () => {
  const bars=[bar(0),bar(1),bar(2)];
  const rows=study(bars,5,'regular',bars[1].time);
  assert.equal(rows.find(r=>r.period==='all'&&r.direction==='green'&&r.streak===2).n,0);
  assert.throws(()=>study([bar(1),bar(0)],5,'regular',start+1000), /Invalid/);
});
test('all-period counts reconcile with the existing research in both candle styles', () => {
  const bars=Array.from({length:100},(_,i)=>bar(i, i%7===0?95:i%3===0?105:101));
  for(const style of ['regular','heikin-ashi']) {
    const cutoff=bars.at(-1).time;
    const rows=study(bars,5,style,cutoff);
    for(const old of analyze(5,style,bars,cutoff).rows) {
      const row=rows.find(r=>r.period==='all'&&r.direction===old.direction&&r.streak===old.streak);
      assert.equal(row.n,old.events);
      assert.equal(row.realSameColor,old.nextBarSameColor);
      assert.equal(row.nextSameColorDoji,old.nextSameColorDoji);
      assert.equal(row.closeFavorable,old.nextCloseFavorable);
    }
  }
});
