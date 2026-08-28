# Log Scanner Manager V4.5

[English](README.md) | [简体中文](README.zh-CN.md)

Log Scanner Manager V4.5 is a dependency-free log governance tool for Android projects. We recommend opening `LogScope-V4.html` directly from the output directory. Its CSS and JavaScript are inlined, so it can be distributed as a single file.

Open `index.html` and select an Android project directory. By default, the tool scans production source code under `src/main`. You can switch to all source sets (`全部源码集`) or select `main` plus a specific source set; changing the scope automatically starts a new scan. Use the `扫描源文件 / 可用` (scanned source files / available) indicator at the top to verify the current statistics scope.

V4.5 recognizes Android Log calls, static imports and Kotlin aliases, Timber, System.out/err, Logger APIs, and custom logging classes and methods. Every detail row and CSV record includes the detection source and source set.

Use the top navigation to switch between the source-log scanner and runtime-log analyzer. Switching pages preserves inputs and results on both pages.

## Interface Screenshots

### Source Log Scanning

Select an Android project directory, configure the source scope and detection rules, then review category totals, module and file rankings, optimization candidates, and expandable log details. The toolbar also provides rescan, clear, AI report copy, CSV export, and baseline import/export actions.

![Log Scanner Manager V4.5 source-log scanning interface](docs/images/source-log-scanner.png)

### Runtime Log Analysis

Select a saved log directory, enter the target package or process, and configure the high-frequency threshold, level preset, and optional keyword. The page summarizes matching PIDs and peak rates, lists high-frequency intervals, and exposes filtered print details for CSV export or AI analysis.

![Log Scanner Manager V4.5 runtime-log analysis interface](docs/images/runtime-log-analysis.png)

## Runtime Log Analysis

Enter a target package or process name, select a directory containing `.log` or `.txt` files, and set the high-frequency threshold (100 lines/second by default). The analyzer first maps the package to PIDs from process-start or package-bearing records, then counts target-PID records per second. Consecutive seconds meeting the threshold become one high-frequency interval.

Results include PID, peak lines per second, interval, peak time and file, interval count, and total PID count. Select an interval, then filter its timestamp, PID/TID, level, tag, message, and source location with a level preset or optional keyword. An empty keyword shows all rows. Both interval summaries and current print rows can be exported as CSV.

The parser currently supports common Android threadtime records and equivalent records with a year. Missing package-to-PID evidence is reported as an error instead of a false zero result. This feature analyzes saved log directories; it does not capture live ADB output.

## Release Notes

### V4.5 (2026-08-28)

- Added saved Android runtime-log analysis with package-to-PID matching, high-frequency interval aggregation, level and keyword filtering, and separate interval and print-detail CSV exports.
- Added one-click generation of AI optimization request text for source and runtime results, with clipboard copy and Markdown download fallback.
- Reworked source and runtime print details into collapsible log cards with escaped full content, per-entry copy, and pagination above the result list.
- Added independent clear actions and state-preserving navigation for the source and runtime workspaces.
- Refreshed the responsive interface with a persistent light/dark theme and keyboard, skip-navigation, and reduced-motion accessibility support.

### V4.2 (2026-08-20)

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
