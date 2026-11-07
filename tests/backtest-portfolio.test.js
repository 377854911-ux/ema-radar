// Run with: node tests/backtest-portfolio.test.js
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ctx={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/backtest-portfolio.js'),'utf8'),ctx);
const run=(trades,opts={})=>ctx.window.emaPortfolio(trades,{initialCapital:1000,notional:100,leverage:1,maxPositions:2,...opts});
const t=(symbol,entryTime,exitTime,pnl)=>({symbol,tf:'1h',entryTime,exitTime,pnl});
let x=run([t('BTC',100,300,-100),t('ETH',100,200,100),t('SOL',150,250,50)]);
assert.equal(x.stats.count,2);assert.equal(x.excluded.capacity,1);
assert.equal(x.stats.maxDrawdown,100); // ETH closes first, BTC loss follows
x=run([t('BTC',100,300,-100),t('ETH',100,200,100),t('SOL',400,500,-20)]);
assert.equal(x.stats.maxDrawdown,120);
assert.equal(x.stats.equity,980);
x=run([t('BTC',100,300,10),t('BTC',200,400,20),t('BTC',401,500,-5)]);
assert.equal(x.stats.count,2);assert.equal(x.excluded.sameSymbol,1);
x=run([t('BTC',100,200,10),t('ETH',100,200,10)],{initialCapital:100,notional:100,maxPositions:2});
assert.equal(x.stats.count,1);assert.equal(x.excluded.margin,1);
x=run([t('BTC',100,200,10),t('ETH',100,200,10)],{maxPositions:1});
assert.equal(x.excluded.capacity,1);
console.log('PASS: chronological exits, drawdown, same-symbol, margin, position limits');
