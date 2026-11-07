'use strict';
function updateBacktestStats(st){const money=n=>Number(n).toFixed(2);$('tradeCount').textContent=String(st.count);$('winRate').textContent=money(st.winRate)+'%';$('grossProfit').textContent=money(st.profit)+' USDT';$('grossLoss').textContent=money(st.loss)+' USDT';$('netProfit').textContent=money(st.net)+' USDT';$('returnPct').textContent=money(st.returnPct)+'%';}
function resetBacktestStats(){for(const id of ['tradeCount','winRate','grossProfit','grossLoss','netProfit','returnPct'])$(id).textContent='—';}
const $=id=>document.getElementById(id);
const ms={ '15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'8h':28800000,'12h':43200000,'1d':86400000 };
let aborter=null;
const api='https://fapi.binance.com';
const fmt=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Africa/Conakry',hour12:false});
function settings(){try{return JSON.parse(localStorage.getItem('ema.settings.backtest')||'{}')}catch{return {}}}
async function json(url,signal){const r=await fetch(url,{signal});if(!r.ok)throw Error('币安 HTTP '+r.status);return r.json()}
async function klines(symbol,tf,days,signal,onPage){
 const interval=ms[tf],end=Date.now(),start=end-days*86400000, warm=start-400*interval;
 let cursor=warm,all=[],pages=0;
 while(cursor<end){
  const batch=await json(api+'/fapi/v1/klines?symbol='+encodeURIComponent(symbol)+'&interval='+tf+'&startTime='+cursor+'&endTime='+end+'&limit=1000',signal);
  if(!Array.isArray(batch)||!batch.length)break;
  for(const c of batch){if(!all.length||Number(c[0])>Number(all[all.length-1][0]))all.push(c)}
  const next=Number(batch[batch.length-1][0])+interval;
  if(next<=cursor)throw Error('历史K线分页未推进');
  cursor=next;onPage(++pages,all.length);
  if(batch.length<1000)break;
 }
 return {all,start,end};
}
function progress(done,total,label){const pct=total?Math.min(100,Math.round(done/total*100)):0;const bar=$('btProgress');if(bar){bar.hidden=false;$('btProgressFill').style.width=pct+'%';$('btProgressFill').setAttribute('aria-valuenow',String(pct));$('btProgressText').textContent=label+' '+done+'/'+total+' · '+pct+'%';}}
function renderLive(trades,config,root,partial=true){const p=config.positionMode==='martingale'?window.emaMartingale(trades,config):window.emaPortfolio(trades,config),st=p.stats;updateBacktestStats(st);const money=n=>Number(n).toFixed(2);$('summary').textContent=(partial?'扫描中 · 临时统计 ｜ ':'')+'已平仓 '+st.count+' 笔 ｜ 净盈亏 '+money(st.net)+' USDT ｜ 收益率 '+money(st.returnPct)+'%';$('actualRR').textContent='实际平均盈亏比：'+(st.realizedRR===null?'暂无足够盈亏样本':'1:'+st.realizedRR.toFixed(2));root.replaceChildren();for(const t of [...p.trades].sort((a,b)=>b.entryTime-a.entryTime)){const card=document.createElement('div');card.className='panel';const title=document.createElement('strong');title.style.color=t.pnl>=0?'#ff656d':'#48d69a';title.textContent=(t.slot?t.slot+'仓 · ':'')+t.symbol+' · '+t.tf+' · '+t.side+' · '+(t.pnl>=0?'盈利 ':'亏损 ')+money(t.pnl)+' USDT';const detail=document.createElement('p');detail.className='muted';detail.textContent='开仓 '+fmt(t.entryTime)+' ｜ 入场 '+Number(t.entry).toFixed(4)+' ｜ 平仓 '+fmt(t.exitTime)+' ｜ 平仓价 '+Number(t.exit).toFixed(4)+' ｜ 手续费 '+money(t.fee)+' USDT';card.append(title,detail);root.append(card)}if(!p.trades.length)root.textContent='尚无符合持仓限制的已平仓交易';return p;}
function analyze(raw,start,end,tf,onMatch,symbol=$('symbol').value.trim().toUpperCase()){
 const periods=[25,50,100],alpha=periods.map(p=>2/(p+1)),ema=[null,null,null];
 const seed=periods.map(()=>[]);let found=0,checked=0,skipped=0;
 for(let i=0;i<raw.length;i++){
  const c=raw[i],t=Number(c[0]),closeTime=Number(c[6]),o=Number(c[1]),cl=Number(c[4]);
  if(!Number.isFinite(o)||!Number.isFinite(cl))continue;
  for(let j=0;j<3;j++){
   if(ema[j]===null){seed[j].push(cl);if(seed[j].length===periods[j])ema[j]=seed[j].reduce((a,b)=>a+b,0)/periods[j]}
   else ema[j]=alpha[j]*cl+(1-alpha[j])*ema[j];
  }
  if(ema.some(x=>x===null)||i<400||t<start||closeTime>=end)continue;
  checked++;
  const next=raw[i+1];
  if(!next||Number(next[0])!==t+ms[tf]||!Number.isFinite(Number(next[1]))){skipped++;continue}
  const lo=Math.min(...ema),hi=Math.max(...ema);
  const long=cl>o&&o<lo&&cl>hi&&ema[2]<ema[0]&&ema[2]<ema[1];
  const short=cl<o&&o>hi&&cl<lo&&ema[2]>ema[0]&&ema[2]>ema[1];
  if(long||short){found++;onMatch({symbol,tf,side:long?'多头':'空头',signalTime:t,entryTime:Number(next[0]),entry:Number(next[1]),signalClose:cl,ema:[...ema]})}
 }
 return {found,checked,skipped};
}
$('stop').onclick=()=>{if(aborter){aborter.abort();$('status').textContent='正在停止…'}};
$('start').onclick=async()=>{
 if(aborter)return;
 const symbol=$('symbol').value.trim().toUpperCase(),tfs=[...document.querySelectorAll('input[name="tf"]:checked')].map(x=>x.value),days=Number($('days').value);
 if(!tfs.length){$('status').textContent='请至少选择一个扫描周期';return}
 if(!/^[A-Z0-9]{3,30}USDT$/.test(symbol)){ $('status').textContent='请输入有效的USDT合约交易对，例如 BTCUSDT';return}
 aborter=new AbortController();$('start').disabled=true;$('tradeResults').textContent='正在扫描，尚未生成已平仓交易';resetBacktestStats();progress(0,1,'准备扫描');$('summary').textContent='正在回测 · 临时统计';$('results').replaceChildren();$('count').textContent='0';
 try{
  if($('scope').value==='market'){
   $('status').textContent='正在核验历史每日成交额排名…';
   const ranked=await window.emaHistoricalUniverse(days,Number(settings().topN??100),aborter.signal,p=>{$('status').textContent='历史排名：'+p.completed+'/'+p.total+' 个交易对，失败 '+p.failed;progress(p.completed,p.total,'历史排名')});
   const config=settings();
   if((config.funding!==false&&config.feeOnly===false)){
    throw Error('全市场模拟暂不支持资金费率；请在设置中启用仅试算');
   }
   config.funding=false;
   const allTrades=[], excluded={ambiguous:0,overlap:0,invalid:0,unfinished:0};
   let done=0,failed=[],signalCount=0,checked=0;
   const cutoff=Math.floor(Date.now()/86400000)*86400000;
   const begin=cutoff-days*86400000;
   const root=$('tradeResults');root.replaceChildren();
   const money=n=>Number(n).toFixed(2);
   const addTrade=t=>{
    const card=document.createElement('div');card.className='panel';
    const title=document.createElement('strong');title.textContent=(t.slot?t.slot+'仓 · ':'')+t.symbol+' · '+t.tf+' · '+t.side+' · '+(t.pnl>=0?'盈利 ':'亏损 ')+money(t.pnl)+' USDT';
    title.style.color=t.pnl>=0?'#ff656d':'#48d69a';
    const detail=document.createElement('p');detail.className='muted';
    detail.textContent='开仓 '+fmt(t.entryTime)+' ｜ 入场 '+t.entry.toFixed(4)+' ｜ 平仓 '+fmt(t.exitTime)+' ｜ 平仓价 '+t.exit.toFixed(4)+' ｜ 手续费 '+money(t.fee)+' USDT';
    card.append(title,detail);root.append(card);
   };
   for(const sym of ranked.symbols){
    if(aborter.signal.aborted)throw new DOMException('已取消','AbortError');
    try{
     for(const tf of tfs){
      if(aborter.signal.aborted)throw new DOMException('已取消','AbortError');
      try{
       const {all}=await klines(sym,tf,days+2,aborter.signal,()=>{});
       if(all.length<401)throw Error('历史K线不足401根');
       const matches=[];
       const outcome=analyze(all,begin,cutoff,tf,x=>{
        const day=Math.floor(x.signalTime/86400000)*86400000;
        if(!ranked.ranks.get(day)?.has(sym))return;
        matches.push(x);signalCount++;
        $('count').textContent=String(signalCount);
       },sym);
       checked+=outcome.checked;
       const sim=window.emaSimulate(all,matches,config);
       for(const k of Object.keys(excluded))excluded[k]+=sim.excluded[k]||0;
       allTrades.push(...sim.trades);
       renderLive(allTrades,config,root);
      }catch(e){if(aborter.signal.aborted)throw e;failed.push(sym+' '+tf+': '+e.message)}
     }
    }catch(e){if(aborter.signal.aborted)throw e;failed.push(sym+': '+e.message)}
    done++;progress(done,ranked.symbols.length,'交易对扫描');
    $('status').textContent='历史K线与撮合 '+done+'/'+ranked.symbols.length+' ｜ 信号 '+signalCount+' ｜ 已平仓 '+allTrades.length+' ｜ 失败 '+failed.length;
    if(done%10===0)await new Promise(resolve=>setTimeout(resolve,0));
   }
   if(failed.length){
    $('status').textContent='扫描未完整：'+failed.length+' 个交易对失败（例如 '+failed.slice(0,3).join('；')+'）。不得将结果当作完整市场回测。';
   }else $('status').textContent='历史逐币种扫描完成：'+done+' 个交易对，'+checked+' 根候选K线，'+signalCount+' 个信号，'+allTrades.length+' 笔已平仓交易。';
   const portfolio=config.positionMode==='martingale'?window.emaMartingale(allTrades,config):window.emaPortfolio(allTrades,config);
   root.replaceChildren();
   const st=portfolio.stats;
   updateBacktestStats(st);
   for(const t of [...portfolio.trades].sort((a,b)=>a.entryTime-b.entryTime))addTrade(t);
   if(config.positionMode==='martingale')$('summary').dataset.martingaleSlots=portfolio.slots.map(x=>x.id+':'+x.increments+(x.paused?'(暂停)':'')).join(' ');
   if(!portfolio.trades.length)root.textContent='没有符合仓位条件的已平仓交易。';
   $('actualRR').textContent='实际平均盈亏比：'+(st.realizedRR===null?'暂无足够盈亏样本':'1:'+st.realizedRR.toFixed(2));
   $('summary').textContent='组合已平仓 '+st.count+' 笔 ｜ 胜率 '+st.winRate.toFixed(2)+'% ｜ 总盈利 '+money(st.profit)+' USDT ｜ 总亏损 '+money(st.loss)+' USDT ｜ 净盈亏 '+money(st.net)+' USDT ｜ 期末资金 '+money(st.equity)+' USDT ｜ 收益率 '+st.returnPct.toFixed(2)+'% ｜ 已实现最大回撤 '+money(st.maxDrawdown)+' USDT ('+st.maxDrawdownPct.toFixed(2)+'%) ｜ 同币种冲突排除 '+portfolio.excluded.sameSymbol+' ｜ 持仓上限排除 '+portfolio.excluded.capacity+' ｜ 保证金不足排除 '+(portfolio.excluded.margin||0)+' ｜ 同根双触及排除 '+excluded.ambiguous+'。尚未计入资金费率及未实现浮动盈亏，回撤为已实现回撤，不是完整账户回撤'+(failed.length?'；数据获取不完整':'')+'。';
   $('results').textContent='历史每日前100过滤后识别 '+signalCount+' 个信号；组合成交 '+st.count+' 笔。详细记录见上方。';
   return;
  }
  const info=await json(api+'/fapi/v1/exchangeInfo',aborter.signal);
  const contract=info.symbols.find(x=>x.symbol===symbol&&x.contractType==='PERPETUAL'&&x.quoteAsset==='USDT');
  if(!contract)throw Error('不是币安USDT永续合约');
  $('status').textContent='正在获取历史K线…';
  const config=settings();
  if(config.feeOnly!==false)config.funding=false;
  const allTrades=[],allRows=[],failed=[];
  let checked=0,found=0,skipped=0,completedTfs=0;
  for(const tf of tfs){
   if(aborter.signal.aborted)throw new DOMException('已取消','AbortError');
   $('status').textContent='正在扫描 '+symbol+' · '+tf;
   try{
    const {all,start,end}=await klines(symbol,tf,days,aborter.signal,()=>{});
    if(all.length<401)throw Error('有效历史K线不足401根');
    const rows=[];
    const stats=analyze(all,start,end,tf,x=>{
     rows.push(x);allRows.push(x);
     const el=document.createElement('div');el.className='panel';
     const heading=document.createElement('strong');heading.style.color=x.side==='多头'?'#ff656d':'#48d69a';
     heading.textContent=x.symbol+' · '+x.tf+' · '+x.side;
     const detail=document.createElement('p');detail.className='muted';
     detail.textContent='信号K线 '+fmt(x.signalTime)+' ｜ 下一根开盘 '+fmt(x.entryTime)+' ｜ 开盘参考价 '+x.entry+' USDT';
     el.append(heading,detail);$('results').prepend(el);$('count').textContent=String(allRows.length);
    });
    checked+=stats.checked;found+=stats.found;skipped+=stats.skipped;
    const sim=window.emaSimulate(all,rows,config);
    allTrades.push(...sim.trades);
    renderLive(allTrades,{...config,maxPositions:1e6},$('tradeResults'));
   }catch(e){if(aborter.signal.aborted)throw e;failed.push(tf+': '+e.message)}
   completedTfs++;progress(completedTfs,tfs.length,'周期扫描');
  }
  const portfolio=config.positionMode==='martingale'?window.emaMartingale(allTrades,config):window.emaPortfolio(allTrades,{...config,maxPositions:1e6});
  const st=portfolio.stats,money=n=>Number(n).toFixed(2);
  updateBacktestStats(st);
  $('actualRR').textContent='实际平均盈亏比：'+(st.realizedRR===null?'暂无足够盈亏样本':'1:'+st.realizedRR.toFixed(2));
  $('summary').textContent='多周期组合已平仓 '+st.count+' 笔 ｜ 胜率 '+st.winRate.toFixed(2)+'% ｜ 总盈利 '+money(st.profit)+' USDT ｜ 总亏损 '+money(st.loss)+' USDT ｜ 净盈亏 '+money(st.net)+' USDT ｜ 收益率 '+st.returnPct.toFixed(2)+'% ｜ 同币种重叠排除 '+portfolio.excluded.sameSymbol+' ｜ 资金费率未计入；当前为试算。'+(failed.length?' 失败周期：'+failed.join('；'):'');
  const root=$('tradeResults');root.replaceChildren();
  for(const t of [...portfolio.trades].sort((a,b)=>b.entryTime-a.entryTime)){
   const card=document.createElement('div');card.className='panel';
   const title=document.createElement('strong');title.style.color=t.pnl>=0?'#ff656d':'#48d69a';
   title.textContent=(t.slot?t.slot+'仓 · ':'')+t.symbol+' · '+t.tf+' · '+t.side+' · '+(t.pnl>=0?'盈利 ':'亏损 ')+money(t.pnl)+' USDT';
   const detail=document.createElement('p');detail.className='muted';
   detail.textContent='开仓 '+fmt(t.entryTime)+' ｜ 入场 '+t.entry.toFixed(4)+' ｜ 平仓 '+fmt(t.exitTime)+' ｜ 平仓价 '+t.exit.toFixed(4)+' ｜ 手续费 '+money(t.fee)+' USDT';
   card.append(title,detail);root.append(card);
  }
  if(!portfolio.trades.length)root.textContent='没有符合条件的已平仓交易';
  if(!allRows.length)$('results').textContent='所选周期未发现信号';
  $('status').textContent='已扫描 '+tfs.join('、')+' ｜ 候选K线 '+checked+' ｜ 信号 '+found+' ｜ 缺少连续K线 '+skipped+' ｜ 已平仓 '+st.count+(failed.length?' ｜ 部分周期失败：'+failed.join('；'):'');

 }catch(e){$('status').textContent=e.name==='AbortError'?'扫描已停止':'扫描失败：'+e.message}
 finally{aborter=null;$('start').disabled=false}
};
const s=settings();if([7,30,60].includes(Number(s.days)))$('days').value=String(s.days);
if([...$('rr').options].some(o=>Number(o.value)===Number(s.rr??1)))$('rr').value=String(Number(s.rr??1));
$('rr').addEventListener('change',()=>{const next=settings();next.rr=Number($('rr').value);localStorage.setItem('ema.settings.backtest',JSON.stringify(next));$('rrDisplay').textContent='盈亏比：1:'+next.rr.toFixed(2)});
const savedTfs=Array.isArray(s.timeframes)?s.timeframes:['30m'];
for(const el of document.querySelectorAll('input[name="tf"]'))el.checked=savedTfs.includes(el.value);
for(const el of document.querySelectorAll('input[name="tf"]'))el.addEventListener('change',()=>{const next=settings();next.timeframes=[...document.querySelectorAll('input[name="tf"]:checked')].map(x=>x.value);localStorage.setItem('ema.settings.backtest',JSON.stringify(next))});

$('rrDisplay').textContent='盈亏比：1:'+(Number(settings().rr??1).toFixed(2));

$('scope').addEventListener('change',()=>{$('symbolField').style.display=$('scope').value==='single'?'flex':'none';$('start').textContent='开始回测';});
$('scope').dispatchEvent(new Event('change'));
