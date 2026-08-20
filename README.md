# Log Scanner Manager V4.2

[English](README.md) | [简体中文](README.zh-CN.md)

Log Scanner Manager V4.2 is a dependency-free log governance tool for Android projects. We recommend opening `LogScope-V4.html` directly from the output directory. Its CSS and JavaScript are inlined, so it can be distributed as a single file.

Open `index.html` and select an Android project directory. By default, the tool scans production source code under `src/main`. You can switch to all source sets (`全部源码集`) or select `main` plus a specific source set; changing the scope automatically starts a new scan. Use the `扫描源文件 / 可用` (scanned source files / available) indicator at the top to verify the current statistics scope.

V4.2 recognizes Android Log calls, static imports and Kotlin aliases, Timber, System.out/err, Logger APIs, and custom logging classes and methods. Every detail row and CSV record includes the detection source and source set.

## V4.2 Release Notes (2026-08-20)

- Fixed the blocked, dead-code, and suspected-dead-code count display; logging calls inside comments are now counted as blocked.
- Added project scan progress and locked related rule controls while scanning to keep the counting scope stable.
- Log details now show both the filtered count and the total scanned count.
- Effective-log file rankings now show the file name and the last three path segments to distinguish duplicate names.
- Toggling common custom logger detection now starts a new scan automatically.

## Baselines and Budgets

1. After a scan finishes, click `导出基线` (Export Baseline).
2. For later scans, use `导入基线` (Import Baseline) to load the JSON file. You can review added, existing, and removed counts, and enable `仅看基线后新增日志` (show only logs added after the baseline).
3. Enter a non-negative integer for `有效日志预算` (effective log budget). If the budget is exceeded, the page displays the difference.

Baseline comparison uses the file, detection source, and log call rather than line numbers, so moving code between lines does not create false additions. Imported files are limited to 25 MB and 250,000 log entries and are validated for format.

## CI Command Line

Node.js 18 or later is required:

```text
node scan-cli.mjs D:\AndroidProject --scope main --format json --output log-report.json --budget 500
```

`--scope` accepts `main`, `all`, and `source:debug`; `--format` accepts `json` and `csv`. Exceeding the budget returns exit code `2`; invalid arguments or project errors return `1`.

A failure to read one file does not stop the full scan. Log details are fixed at 50 entries per page and can be browsed with the previous and next page controls. Long log calls are collapsed to three lines by default; click `展开` (Expand) to view the full call. Expanded content scrolls within the cell when it exceeds 320 px. CSV export always includes all currently filtered results and is unaffected by pagination.

Analysis boundary: the user requested skipping directly to phase four, so phase-three Gradle Variant combination parsing, complete Java/Kotlin AST analysis, and R8 reachability analysis have not been implemented. Source sets are inferred from paths, and dead code is identified with high-confidence heuristics; uncertain cases are not silently excluded.
