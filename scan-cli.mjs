#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import vm from "node:vm";

const appSource = await readFile(new URL("./app.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(appSource, sandbox);
const core = sandbox.LogCounterCore;

function usage() {
  return `Usage: node scan-cli.mjs <project> [options]

Options:
  --scope main|all|source:<name>  Scan scope (default: main)
  --format json|csv              Output format (default: json)
  --output <file>                Write report to a file
  --budget <number>              Exit 2 when effective logs exceed budget
  --custom-classes <names>       Comma-separated custom logger classes
  --logger-objects <names>       Comma-separated logger object names
  --help                         Show this help`;
}

function parseArgs(argv) {
  if (!argv.length || argv.includes("--help")) return { help: true };
  const options = {
    project: resolve(argv[0]),
    scope: "main",
    format: "json",
    customClasses: "LogUtil,LogUtils,Logger,MLog,KLog,XLog,ALog,L",
    loggerObjects: "LOG,LOGGER,log,logger,mLogger"
  };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--scope", "--format", "--output", "--budget", "--custom-classes", "--logger-objects"].includes(flag) || value == null) {
      throw new Error("Invalid argument: " + flag);
    }
    i += 1;
    if (flag === "--scope") options.scope = value;
    else if (flag === "--format") options.format = value;
    else if (flag === "--output") options.output = resolve(value);
    else if (flag === "--budget") options.budget = Number(value);
    else if (flag === "--custom-classes") options.customClasses = value;
    else if (flag === "--logger-objects") options.loggerObjects = value;
  }
  if (!/^(?:main|all|source:[A-Za-z0-9_.-]+)$/.test(options.scope)) throw new Error("Invalid scope: " + options.scope);
  if (!/^(?:json|csv)$/.test(options.format)) throw new Error("Invalid format: " + options.format);
  if (options.budget != null && (!Number.isInteger(options.budget) || options.budget < 0)) throw new Error("Budget must be a non-negative integer");
  return options;
}

async function sourceFiles(root) {
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (core.shouldEnterDirectory(entry.name)) await visit(path);
      } else if (entry.isFile() && core.shouldScanFile(path)) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!(await stat(options.project)).isDirectory()) throw new Error("Project path is not a directory");

  const projectName = basename(options.project);
  const candidates = await sourceFiles(options.project);
  const selected = candidates.filter((file) => core.matchesSourceScope(projectName + "/" + relative(options.project, file).replace(/\\/g, "/"), options.scope));
  const failures = [];
  const rows = [];
  for (const file of selected) {
    const path = projectName + "/" + relative(options.project, file).replace(/\\/g, "/");
    try {
      rows.push(...core.analyzeText(await readFile(file, "utf8"), path, options));
    } catch (error) {
      failures.push({ file: path, error: error.message });
    }
  }
  core.markDuplicates(rows);
  const summary = core.summarize(rows);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: projectName,
    scope: options.scope,
    files: { scanned: selected.length, available: candidates.length, failed: failures.length },
    counts: {
      all: summary.all,
      effective: summary.effective,
      blocked: summary.blocked,
      dead: summary.dead,
      suspected: summary.suspected
    },
    sources: Object.fromEntries(summary.sources),
    failures,
    rows
  };
  const output = options.format === "csv" ? core.toCsv(rows) : JSON.stringify(report, null, 2);
  if (options.output) {
    await writeFile(options.output, output, "utf8");
    console.error("Wrote " + options.output);
  } else {
    process.stdout.write(output + "\n");
  }
  if (options.budget != null && summary.effective > options.budget) {
    console.error("Log budget exceeded: " + summary.effective + " > " + options.budget);
    process.exitCode = 2;
  }
}

run().catch((error) => {
  console.error("LogScope: " + error.message);
  console.error(usage());
  process.exitCode = 1;
});
