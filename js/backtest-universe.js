'use strict';
// Historical universe discovery only. Daily UTC quote volume is a proxy, NOT rolling 24h turnover.
window.emaHistoricalUniverse=async function(days,topN,signal,progress){
 const api='https://fapi.binance.com',DAY=86400000;
 const get=async url=>{const r=await fetch(url,{signal});if(!r.ok)throw Error('币安历史排名 HTTP '+r.status);return r.json()};
 const info=await get(api+'/fapi/v1/exchangeInfo');
 const symbols=info.symbols.filter(x=>x.contractType==='PERPETUAL'&&x.quoteAsset==='USDT'&&x.status==='TRADING'&&(!x.onboardDate||Number(x.onboardDate)<Date.now()-DAY)).map(x=>x.symbol);
 const end=Math.floor(Date.now()/DAY)*DAY,start=end-days*DAY;
 const daily=new Map();for(let t=start;t<end;t+=DAY)daily.set(t,[]);
 let cursor=0,failed=[],completed=0;
 const worker=async()=>{
  while(cursor<symbols.length){
   if(signal.aborted)throw new DOMException('已取消','AbortError');
   const sym=symbols[cursor++];
   try{
    const url=api+'/fapi/v1/klines?symbol='+encodeURIComponent(sym)+'&interval=1d&startTime='+(start-DAY)+'&endTime='+(end-1)+'&limit='+Math.min(days+2,1000);
    const rows=await get(url);
    const byDay=new Map(rows.map(k=>[Number(k[0]),k]));
    for(let t=start;t<end;t+=DAY){
     // Prior CLOSED UTC day, to avoid ranking on future information.
     const k=byDay.get(t-DAY);
     if(!k)continue;
     const vol=Number(k[7]);if(Number.isFinite(vol)&&vol>0)daily.get(t).push({symbol:sym,vol});
    }
   }catch(e){if(signal.aborted)throw e;failed.push(sym)}
   completed++;progress({completed,total:symbols.length,failed:failed.length});
  }
 };
 await Promise.all(Array.from({length:3},worker));
 if(failed.length)throw Error('有 '+failed.length+' 个交易对历史成交额获取失败；排名不完整，拒绝生成前100');
 const ranks=new Map(),universe=new Set();
 for(const [day,items] of daily){
  if(items.length<topN)throw Error(new Date(day).toISOString().slice(0,10)+' 历史样本不足 '+topN+'，拒绝冒充完整前100');
  items.sort((a,b)=>b.vol-a.vol);
  const top=new Set(items.slice(0,topN).map(x=>x.symbol));ranks.set(day,top);for(const x of top)universe.add(x);
 }
 return {ranks,symbols:[...universe],days:daily.size,method:'前一完整UTC日成交额排名（不是精确滚动24小时排名）'};
};