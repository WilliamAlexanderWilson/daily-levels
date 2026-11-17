#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const Doji=require('../site/doji-study.js');
const Runs=require('../site/marker-runs.js');
const {analyze}=require('./analyze-spy-doji-streaks.js');
const {study}=require('./study-spy-marker-sequences.js');
const spec=require('../research/spy-marker-forward-v1.json');
const DATA=path.join(__dirname,'../site/data');
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function forward(bars,cutoff,definition=spec){
  const start=Date.parse(definition.startUtc)/1000;
  if(definition.minutes!==5||definition.style!=='regular'||definition.depth!==5||definition.bodyRatioMax!==0.1||definition.bodyRatioMax!==Doji.MAX_BODY_RATIO||definition.direction!=='green'||!Number.isFinite(start))throw new Error('Unsupported frozen definition');
  analyze(5,'regular',bars,cutoff);
  bars=bars.filter(b=>b.time<=cutoff);
  const markers=Doji.findCompleted(bars,{intervalMinutes:5,style:'regular',timeIsClose:true,completedThroughUnix:cutoff});
  const runs=Runs.annotate(markers),index=new Map(bars.map((b,i)=>[b.time,i]));
  const events=[],baseline={n:0,same:0,pending:0};
  for(let j=0;j<markers.length;j++){
    const signal=markers[j],run=runs[j],next=markers[j+1];
    if(signal.time<=start||run.direction!=='green')continue;
    if(next){baseline.n++;baseline.same+=Number(next.close>=next.open);}else baseline.pending++;
    if(!run.knownStart||run.count!==5)continue;
    const i=index.get(signal.time),future=bars[i+3];
    const valid=future&&day.format(new Date(future.time*1000))===day.format(new Date(signal.time*1000))&&[1,2,3].every(k=>bars[i+k].time-bars[i+k-1].time<=300);
    events.push({signalTime:signal.time,runStart:run.first,flatMarkers:run.flat,sessionCrossings:run.crossings,nextTime:next?.time??null,nextGreen:next?next.close>=next.open:null,nextFlat:next?next.close===next.open:null,price3Higher:valid?future.close>signal.close:null});
  }
  const resolved=events.filter(e=>e.nextGreen!==null),price=events.filter(e=>e.price3Higher!==null);
  return {definition,asOfUtc:new Date(cutoff*1000).toISOString(),status:cutoff<start?'not-started':'collecting',n:resolved.length,same:resolved.filter(e=>e.nextGreen).length,pending:events.length-resolved.length,baseline,price3:{n:price.length,same:price.filter(e=>e.price3Higher).length},reviewReady:cutoff>=Date.parse(definition.reviewNotBeforeUtc)/1000&&resolved.length>=definition.minimumResolvedEventsForReview,events};
}
function build(){
  const manifest=JSON.parse(fs.readFileSync(path.join(DATA,'archive/spy/manifest.json'))),chart=JSON.parse(fs.readFileSync(path.join(DATA,'spy_chart.json')));
  const cutoff=Date.parse(chart.generated_at_utc)/1000,rows=[],coverage=[];let prospective;
  for(const minutes of [1,5,10,15,20,30,60,240]){
    const bars=manifest.timeframes[minutes].flatMap(e=>{const chunk=JSON.parse(fs.readFileSync(path.join(DATA,e.path)));if(chunk.length!==e.count||chunk[0]?.time!==e.first||chunk.at(-1)?.time!==e.last)throw new Error('Manifest mismatch');return chunk;}).sort((a,b)=>a.time-b.time);
    const completed=bars.filter(b=>b.time<=cutoff);coverage.push({minutes,first:completed[0].time,last:completed.at(-1).time});
    for(const style of ['regular','heikin-ashi'])for(const row of study(bars,minutes,style,cutoff))if(row.period==='all')rows.push({minutes,style,direction:row.direction,depth:row.depth,n:row.n,same:row.same,price:row.price});
    if(minutes===5)prospective=forward(bars,cutoff);
  }
  return {schemaVersion:1,sourceGeneratedAtUtc:chart.generated_at_utc,coverage,rows,forward:prospective};
}
if(require.main===module)process.stdout.write(JSON.stringify(build())+'\n');
module.exports={forward,build};
