import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("historical backtest page contains syntactically valid module script", () => {
  const html = readFileSync(new URL("../backtest.html", import.meta.url), "utf8");
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, "backtest page module script should exist");
  const source = match[1].replace(/^import\s+.*?;\s*$/gm, "");
  assert.doesNotThrow(() => new vm.Script(source));
});

test("backtest page persists its own settings separately from scanner settings", () => {
  const html = readFileSync(new URL("../backtest.html", import.meta.url), "utf8");
  assert.match(html, /ema-radar-v1-backtest-settings/);
  assert.ok(html.includes("1 : 1.1"));
  assert.ok(html.includes("策略收益率（按初始资金）"));
  assert.ok(html.includes("实际注入资金"));
  assert.equal(html.includes('value="10m"'), false);
  assert.match(html, /localStorage\.setItem\(KEY,JSON\.stringify\(settings\)\)/);
});


test("live scanner and historical backtest expose the same saved funding thresholds", () => {
  const scanner = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const backtest = readFileSync(new URL("../backtest.html", import.meta.url), "utf8");
  for (const html of [scanner, backtest]) {
    for (const threshold of ['value="0.01"', 'value="0.02"', 'value="0.03"', 'value="0.05"', 'value="0.1"']) {
      assert.ok(html.includes(threshold), "both pages should offer " + threshold);
    }
    assert.ok(html.includes("fundingCustomPct"));
  }
  assert.ok(scanner.includes("fundingFilterPct: Number(settings.fundingFilterPct)"));
  assert.ok(backtest.includes("fundingFilterPct:Number(s.fundingFilterPct)"));
  assert.ok(backtest.includes("历史费率缺失信号"));
});


test("live scanner page contains a syntactically valid module script", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/<script type="module">([\\s\\S]*?)<\\/script>/);
  assert.ok(match, "scanner page module script should exist");
  const source = match[1].replace(/^import\\s+.*?;\\s*$/gm, "");
  assert.doesNotThrow(() => new vm.Script(source));
});
