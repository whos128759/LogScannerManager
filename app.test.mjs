import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const page = await readFile(new URL("./index.html", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(source, sandbox);
const core = sandbox.LogCounterCore;

test("maps package PID and merges consecutive high-frequency seconds", () => {
  const packageName = "com.adayo.energycenter";
  const matcher = core.createRuntimePackageMatcher(packageName);
  const start = core.parseRuntimeLine(
    "08-27 10:39:59.900 1000 1001 I ActivityManager: Start proc 32452:com.adayo.energycenter/u0a123",
    "logcat-a.txt",
    1
  );
  assert.equal(start.pid, "1000");
  assert.equal(core.findRuntimePackagePid(start.raw, start, matcher).pid, "32452");
  assert.equal(core.findRuntimePackagePid(start.raw, start, matcher).reliable, true);

  const rows = [];
  const add = (second, count, file) => {
    for (let i = 0; i < count; i += 1) {
      rows.push(core.parseRuntimeLine(
        `08-27 10:40:0${second}.${String(i).padStart(3, "0")} 32452 32460 D Energy: print ${second}-${i}`,
        file,
        rows.length + 1
      ));
    }
  };
  add(0, 4, "logcat-a.txt");
  add(1, 3, "logcat-b.txt");
  add(2, 2, "logcat-b.txt");
  add(3, 3, "logcat-b.txt");

  const result = core.analyzeRuntimeRows(rows, 3, packageName);
  assert.equal(result.matched, 12);
  assert.equal(result.pidCount, 1);
  assert.equal(result.maxRate, 4);
  assert.equal(result.intervals.length, 2);
  assert.equal(result.intervals[0].intervalLogs, 7);
  assert.equal(result.intervals[0].peakFile, "logcat-a.txt");
  assert.equal(result.intervals[0].pidTotalLogs, 12);
  assert.equal(result.intervals[1].intervalLogs, 3);
  const report = core.runtimeAiReport({
    packageName,
    directory: "log-20260827",
    fileCount: 2,
    threshold: 3,
    levelLabel: "WARN 及以上",
    keyword: "timeout",
    analysis: result,
    rows,
    sampleRows: rows.slice(0, 2),
    selectedInterval: result.intervals[0]
  });
  assert.match(report, /Android 高频日志优化分析请求/);
  assert.match(report, /com\.adayo\.energycenter/);
  assert.match(report, /峰值条数\/秒/);
  assert.match(report, /WARN 及以上；关键词 `timeout`/);
  assert.match(report, /Energy: print 0-0/);
  assert.throws(() => core.createRuntimePackageMatcher("bad package"), /包名只能包含/);
});

test("renders runtime rows collapsed with escaped highlighted details", () => {
  const html = core.renderRuntimeLogItem({
    timestamp: "08-27 10:46:39.001",
    pid: "4149",
    tid: "4150",
    process: "com.example.app",
    level: "I",
    tag: "Energy",
    message: "register(<script>alert(1)</script>)",
    file: "logs/logcat.txt",
    line: 41952
  });

  assert.match(html, /^<details class="runtime-log-item"/);
  assert.doesNotMatch(html, /<details[^>]+ open/);
  assert.match(html, /<code class="runtime-log-preview">register\(&lt;script&gt;/);
  assert.match(html, /<div class="runtime-log-code">/);
  assert.match(html, /class="runtime-copy-code"[^>]+aria-label="复制完整日志内容"/);
  assert.doesNotMatch(html, /<script>/);
});

test("renders source rows with the same collapsed detail design", () => {
  const html = core.renderSourceLogItem({
    category: "effective",
    baselineStatus: "new",
    level: "DEBUG",
    source: "LogUtil",
    module: "app",
    sourceSet: "main",
    file: "app/src/main/java/Test.java",
    line: 42,
    snippet: "LogUtil.d(\"<tag>\")",
    reason: "有效日志",
    candidates: ["循环内日志"]
  });

  assert.match(html, /^<details class="runtime-log-item source-log-item"/);
  assert.doesNotMatch(html, /<details[^>]+ open/);
  assert.match(html, /完整日志调用/);
  assert.match(html, /class="runtime-copy-code"[^>]+aria-label="复制完整日志调用"/);
  assert.match(html, /判定原因 \/ 优化候选/);
  assert.match(html, /LogUtil\.d\(&quot;&lt;tag&gt;&quot;\)/);
});

test("builds a source AI prompt from governance results and visible samples", () => {
  const rows = [{
    category: "effective",
    level: "DEBUG",
    source: "LogUtil",
    module: "app",
    file: "app/src/main/java/Test.java",
    line: 42,
    reason: "有效日志",
    candidates: ["循环日志"],
    snippet: "LogUtil.d(\"tick\")"
  }];
  const report = core.sourceAiReport({
    project: "Demo",
    scopeLabel: "生产源码（src/main）",
    fileCount: 8,
    filterLabel: "分类 有效；关键词 `tick`",
    budgetLabel: "100",
    baselineLabel: "新增 1 / 已有 0 / 移除 0",
    rows,
    sampleRows: rows
  });

  assert.match(report, /Android 源码日志优化分析请求/);
  assert.match(report, /P0 \/ P1 \/ P2/);
  assert.match(report, /循环日志/);
  assert.match(report, /Test\.java:42/);
  assert.match(report, /LogUtil\.d\("tick"\)/);
  assert.match(report, /<scan_data>/);
});

test("keeps long runtime sections collapsible and pagers above detail rows", () => {
  assert.match(page, /<details class="[^"]*collapsible-panel[^"]*" open>[\s\S]*?<h2>高频时间段<\/h2>/);
  assert.match(page, /<details class="[^"]*collapsible-panel[^"]*" open>[\s\S]*?<h2>打印数据<\/h2>/);
  assert.ok(page.indexOf('id="pageInfo"') < page.indexOf('id="resultRows"'));
  assert.ok(page.indexOf('id="runtimePageInfo"') < page.indexOf('id="runtimePrintRows"'));
});
