'use strict';
// Single-symbol experimental "signal forming entry" backtest.
// Uses completed 1-minute bars. Entries occur at NEXT minute open; never at a price known only later.
window.emaFormingBacktest=async function(symbol,tfs,days,config,signal,onProgress){
 const api='https://fapi.binance.com/fapi/v1/klines';
 const minMs=60000, end=Math.floor(Date.now()/minMs)*minMs, start=end-days*86400000;
 const interval={'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'8h':28800000,'12h':43200000,'1d':86400000};
 const number=(c,n)=>Number(c[n]);
 async function load(tf,from,to){
  const step=tf==='1m'?minMs:interval[tf],out=[];
  for(let cursor=from;cursor<to;){
   if(signal.aborted)throw new DOMException('已取消','AbortError');
   const url=api+'?symbol='+encodeURIComponent(symbol)+'&interval='+tf+'&startTime='+cursor+'&endTime='+(to-1)+'&limit=1000';
   const res=await fetch(url,{signal});if(!res.ok)throw Error('币安 '+tf+' 历史数据 HTTP '+res.status);
   const batch=await res.json();if(!Array.isArray(batch)||!batch.length)break;
   for(const c of batch){const t=number(c,0);if(t>=from&&t<to&&(!out.length||t>number(out[out.length-1],0)))out.push(c)}
   const next=number(batch[batch.length-1],0)+step;if(next<=cursor)throw Error(tf+' K线分页错误');
   cursor=next;
   if(tf==='1m'&&out.length%5000<1000)onProgress('下载1分钟历史K线：'+out.length+'根');
   if(batch.length<1000)break;
  }
  return out;
 }
 const minutes=await load('1m',start,end);
 if(!minutes.length)throw Error('没有取得1分钟历史K线');
 const minuteMap=new Map(minutes.map((c,i)=>[number(c,0),i]));
 const entryFee=Number(config.entryFee??0.02)/100,tpFee=Number(config.tpFee??0.02)/100,slFee=Number(config.slFee??0.05)/100;
 const hardStop=Number(config.hardStop??2)/100,slippage=Number(config.slippage??0.05)/100,rr=Number(config.rr??1);
 const early=Number(config.formingEarlyTp??5)/100,notional=Number(config.notional??1000),hold=Math.max(1,Math.floor(Number(config.holdCandles??9)));
 if(!(early>=0.01&&early<=0.10)||!(notional>0)||!(rr>0)||!(hardStop>0))throw Error('信号形成中止盈参数无效');
 const trades=[],rows=[],candidates=[];const excluded={ambiguous:0,invalid:0,unfinished:0,incomplete:0,occupied:0,late:0,notFilled:0};
 for(const tf of tfs){
  if(signal.aborted)throw new DOMException('已取消','AbortError');
  onProgress('正在进行 '+tf+' 信号形成中回测…');
  const step=interval[tf],parent=await load(tf,Math.max(0,start-405*step),end);
  const lengths=[25,50,100],a=lengths.map(n=>2/(n+1)),seed=lengths.map(()=>[]),ema=[null,null,null];
  let active=null,busyUntil=0;
  function valid(o,cl,e,high,low){
   const lo=Math.min(...e),hi=Math.max(...e),body=Math.abs(cl-o);
   const isLong=cl>o&&o<lo&&cl>hi&&e[2]<e[0]&&e[2]<e[1];
   const isShort=cl<o&&o>hi&&cl<lo&&e[2]>e[0]&&e[2]>e[1];
   return {long:isLong,short:isShort,body,wickLong:high-cl,wickShort:cl-low};
  }
  function finish(p,price,time,type,feeRate){
   const qty=notional/p.entry,gross=(p.long?1:-1)*(price-p.entry)*qty;
   const fee=notional*entryFee+price*qty*feeRate;
   trades.push({symbol,tf,side:p.long?'多头':'空头',signalTime:p.signalTime,entryTime:p.entryTime,entry:p.entry,exitTime:time,exit:price,exitType:type,stop:p.stop,target:p.target??null,gross,fee,pnl:gross-fee,qty,forming:true});
   busyUntil=Math.max(busyUntil,time);
  }
  for(let i=0;i<parent.length;i++){
   const c=parent[i],t=number(c,0),o=number(c,1),cl=number(c,4);
   if(!Number.isFinite(cl))continue;
   // Snapshot of EMA immediately before this parent candle; intrabar EMA is provisional.
   const previous=[...ema];
   const ready=i>=400&&previous.every(x=>x!==null);
   if(ready&&t>=start&&t+step<=end){
    let high=o,low=o,trigger=null,signalLogged=false;
    const first=minuteMap.get(t),count=step/minMs;
    let complete=first!==undefined;
    if(complete){for(let j=0;j<count;j++){if(!minutes[first+j]||number(minutes[first+j],0)!==t+j*minMs){complete=false;break}}}
    if(!complete){if(active)throw Error(tf+' 持仓期间1分钟历史K线不连续，已停止以避免错误盈亏');excluded.incomplete++;}
    else{
     for(let j=0;j<count;j++){
      const m=minutes[first+j],mt=number(m,0),mo=number(m,1),mh=number(m,2),ml=number(m,3),mc=number(m,4);
      if(![mo,mh,ml,mc].every(Number.isFinite)){complete=false;break}
      high=Math.max(high,mh);low=Math.min(low,ml);
      // A signal can first be confirmed only at the close of a completed 1m bar.
      // Match a market order at the following 1m open; evaluate that entry bar thereafter.
      if(trigger&&j===trigger.j+1){
       if(!active&&mt>=busyUntil){
        const entry=mo,long=trigger.long;
        const structural=config.stopMode==='hard_extreme'?(long?trigger.low:trigger.high):o;
        const hard=long?entry*(1-hardStop):entry*(1+hardStop);
        const stop=long?Math.max(hard,structural):Math.min(hard,structural);
        if(entry>0&&(long?stop<entry:stop>entry)){
         active={long,entry,entryTime:mt,signalTime:t,stop,earlyPrice:long?entry*(1+early):entry*(1-early),target:null,deadline:t+(hold+1)*step};
         rows.push({symbol,tf,side:long?'多头':'空头',signalTime:t,entryTime:mt,entry,forming:true});
         trigger.candidate.status='入场';
        }else {excluded.invalid++;trigger.candidate.status='止损价无效';}
       }else {excluded.occupied++;trigger.candidate.status='已有持仓';}
       trigger=null;
      }
      // Entry is at the minute open: both stop and TP can apply to this very minute.
      if(active&&mt>=active.entryTime){
       const s=active,hitStop=s.long?ml<=s.stop:mh>=s.stop;
       const hitTarget=s.target!==null&&(s.long?mh>=s.target:ml<=s.target);
       const hitEarly=s.target===null&&(s.long?mh>=s.earlyPrice:ml<=s.earlyPrice);
       if(hitStop&&(hitTarget||hitEarly)){
        excluded.ambiguous++;busyUntil=mt+minMs;
        const row=rows.findLast(x=>x.tf===tf&&x.entryTime===s.entryTime);
        if(row)row.status='同分钟止盈止损冲突，不计入';
        active=null;
       }
       else if(hitStop){const fill=(s.long?Math.min(mo,s.stop):Math.max(mo,s.stop))*(s.long?1-slippage:1+slippage);finish(s,fill,mt+minMs,'stop',slFee);active=null}
       else if(hitTarget||hitEarly){const target=s.target??s.earlyPrice;const fill=s.long?Math.max(mo,target):Math.min(mo,target);finish(s,fill,mt+minMs,hitEarly?'forming_early_tp':'target',tpFee);active=null}
      }
      if(!signalLogged){
       const e=previous.map((x,k)=>a[k]*mc+(1-a[k])*x),v=valid(o,mc,e,high,low);
       if(v.long||v.short){
        signalLogged=true;
        const candidate={symbol,tf,side:v.long?'多头':'空头',signalTime:t,detectedTime:mt+minMs,status:'候选'};
        candidates.push(candidate);
        if(j===count-1){candidate.status='最后一分钟才形成，无法在收盘前入场';excluded.late++;}
        else if(active||mt<busyUntil){candidate.status='已有持仓';excluded.occupied++;}
        else trigger={j,long:v.long,high,low,candidate};
       }
      }
      // Parent K-line close: signal validity and the final candle-based take profit.
      if(j===count-1&&active&&active.signalTime===t){
       const e=previous.map((x,k)=>a[k]*mc+(1-a[k])*x),v=valid(o,mc,e,high,low);
       const still=active.long?v.long&&v.wickLong<v.body*0.5:v.short&&v.wickShort<v.body*0.5;
       if(!still){finish(active,mc,mt+minMs,'signal_invalid',slFee);active=null}
       else {
        const move=Math.abs(mc-o)/o,rate=move*rr;
        active.target=active.long?active.entry*(1+rate):active.entry*(1-rate);
        active.earlyPrice=null;
        // Target becomes active AFTER this parent candle closes.
       }
      }
      // Time exit: hold limit after the signal candle, at completed parent bar close.
      if(j===count-1&&active&&t+step>=active.deadline){finish(active,mc,mt+minMs,'timeout',tpFee);active=null}
     }
     if(!complete)excluded.incomplete++;
    }
   }
   for(let k=0;k<3;k++){if(ema[k]===null){seed[k].push(cl);if(seed[k].length===lengths[k])ema[k]=seed[k].reduce((x,y)=>x+y,0)/lengths[k]}else ema[k]=a[k]*cl+(1-a[k])*ema[k]}
  }
  if(active){excluded.unfinished++;active=null}
 }
 return {trades,rows,candidates,excluded,minuteCount:minutes.length};
};
