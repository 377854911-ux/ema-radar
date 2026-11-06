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
  assert.match(html, /1 : 1\\.1/);
  assert.match(html, /localStorage\.setItem\(KEY,JSON\.stringify\(settings\)\)/);
});
