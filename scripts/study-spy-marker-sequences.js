#!/usr/bin/env node
'use strict';
// Marker sequences: ordinary candles do not reset the run. Research only.
const fs = require('node:fs');
const path = require('node:path');
const Doji = require('../site/doji-study.js');
const {analyze, wilson95} = require('./analyze-spy-doji-streaks.js');
const DATA = path.join(__dirname, '../site/data');
const PERIODS = ['all','2020-2023','2024-2025','2026'];
const dayFormat = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const period = t => {const y = new Date(t*1000).getUTCFullYear(); return y<2024?'2020-2023':y<2026?'2024-2025':'2026';};
const count = () => ({n:0,same:0});
function empty() {return {observed:0,censored:0,...count(),ageMinutesTotal:0,waitMinutesTotal:0,ages:{under60:count(),from60to240:count(),over240:count()},price:Object.fromEntries([1,3,5].map(h=>[h,count()]))};}
function study(bars,minutes,style,cutoff,mode='continuous',colorPolicy='chart') {
  if (!['continuous','session'].includes(mode)) throw new Error('Invalid sequence mode');
  if (!['chart','neutral-flat'].includes(colorPolicy)) throw new Error('Invalid color policy');
  analyze(minutes,style,bars,cutoff); // Existing strict OHLC/order/cutoff validator.
  bars=bars.filter(b=>b.time<=cutoff);
  const indexes=new Map(bars.map((b,i)=>[b.time,i]));
  const days=bars.map(b=>dayFormat.format(new Date(b.time*1000)));
  const markers=Doji.findCompleted(bars,{intervalMinutes:minutes,style,timeIsClose:true,completedThroughUnix:cutoff});
  const rows=new Map();
  for(const direction of ['green','red']) for(const depth of ['any',1,2,3,4,5,'6+']) for(const p of PERIODS)
    rows.set(`${direction}|${depth}|${p}`,{minutes,style,mode,colorPolicy,direction,depth,period:p,...empty()});
  let run=0,runStart=0,previous=null;
  for(let j=0;j<markers.length;j++) {
    const marker=markers[j],next=markers[j+1],i=indexes.get(marker.time);
    if(colorPolicy==='neutral-flat'&&marker.close===marker.open) {previous=null;run=0;continue;}
    const green=marker.close>=marker.open,direction=green?'green':'red';
    const sameSession=previous&&days[indexes.get(previous.time)]===days[i];
    if(previous&&(previous.close>=previous.open)===green&&(mode==='continuous'||sameSession))run++;
    else {run=1;runStart=marker.time;}
    previous=marker;
    const depth=run>=6?'6+':run;
    const age=(marker.time-runStart)/60;
    const ageBin=age<=60?'under60':age<=240?'from60to240':'over240';
    const eligible=next&&(mode==='continuous'||days[indexes.get(next.time)]===days[i]);
    const same=eligible&&(colorPolicy==='chart'||next.close!==next.open)&&((next.close>=next.open)===green);
    for(const p of ['all',period(marker.time)])for(const d of ['any',depth]) {
      const row=rows.get(`${direction}|${d}|${p}`);row.observed++;
      if(eligible&&(p==='all'||period(next.time)===p)) {
        row.n++;row.same+=Number(same);row.ageMinutesTotal+=age;row.waitMinutesTotal+=(next.time-marker.time)/60;
        row.ages[ageBin].n++;row.ages[ageBin].same+=Number(same);
      } else row.censored++;
      // Fixed-horizon real-price outcomes have their own denominators, independent
      // of whether a later doji exists. Exclude overnight and missing-bar paths.
      for(const h of [1,3,5]) {
        const future=bars[i+h];
        if(!future||days[i+h]!==days[i]||(p!=='all'&&period(future.time)!==p))continue;
        let contiguous=true;
        for(let k=i+1;k<=i+h;k++)if(bars[k].time-bars[k-1].time>minutes*60)contiguous=false;
        if(!contiguous)continue;
        row.price[h].n++;row.price[h].same+=Number(green?future.close>bars[i].close:future.close<bars[i].close);
      }
    }
  }
  return [...rows.values()].map(row=>({...row,wilson95:wilson95(row.same,row.n)}));
}
function build() {
  const manifest=JSON.parse(fs.readFileSync(path.join(DATA,'archive/spy/manifest.json')));
  const chart=JSON.parse(fs.readFileSync(path.join(DATA,'spy_chart.json')));
  const cutoff=Date.parse(chart.generated_at_utc)/1000;
  const rows=[],coverage=[];
  for(const minutes of [1,5,10,15,20,30,60,240]) {
    const bars=manifest.timeframes[minutes].flatMap(e=>{
      const chunk=JSON.parse(fs.readFileSync(path.join(DATA,e.path)));
      if(chunk.length!==e.count||chunk[0]?.time!==e.first||chunk.at(-1)?.time!==e.last)throw new Error('Archive mismatch: '+e.path);
      return chunk;
    }).sort((a,b)=>a.time-b.time);
    const completed=bars.filter(b=>b.time<=cutoff);
    coverage.push({minutes,n:completed.length,first:completed[0].time,last:completed.at(-1).time});
    for(const style of ['regular','heikin-ashi'])for(const mode of ['continuous','session'])for(const colorPolicy of ['chart','neutral-flat'])rows.push(...study(bars,minutes,style,cutoff,mode,colorPolicy));
  }
  return {source:manifest.source,sourceGeneratedAtUtc:chart.generated_at_utc,coverage,rows};
}
if(require.main===module)process.stdout.write(JSON.stringify(build())+'\n');
module.exports={study};
