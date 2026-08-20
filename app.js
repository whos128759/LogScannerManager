(function (global) {
  "use strict";

  const SOURCE_RE = /\.(java|kt|kts)$/i;
  const SKIP_SEGMENTS = new Set([
    ".git", ".gradle", ".idea", ".cxx", "build", "generated", "intermediates",
    "node_modules", "out", "captures"
  ]);
  const LEVEL_NAME = {
    v: "VERBOSE",
    d: "DEBUG",
    i: "INFO",
    w: "WARN",
    e: "ERROR",
    wtf: "WTF",
    println: "PRINTLN",
    print: "PRINT",
    printf: "PRINTF",
    debug: "DEBUG",
    info: "INFO",
    warn: "WARN",
    warning: "WARN",
    error: "ERROR",
    trace: "TRACE",
    log: "LOG"
  };

  function splitPath(path) {
    return String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  }

  function shouldScanFile(path) {
    const parts = splitPath(path);
    return SOURCE_RE.test(path) && !parts.some((part) => SKIP_SEGMENTS.has(part.toLowerCase()));
  }

  function shouldEnterDirectory(name) {
    return !SKIP_SEGMENTS.has(String(name || "").toLowerCase());
  }

  function inferProject(path) {
    return splitPath(path)[0] || "Android 项目";
  }

  function inferModule(path) {
    const parts = splitPath(path);
    const src = parts.indexOf("src");
    if (src > 1) return parts.slice(1, src).join("/");
    return parts[1] || "(root)";
  }

  function inferSourceSet(path) {
    const parts = splitPath(path);
    const src = parts.indexOf("src");
    return src >= 0 && parts[src + 1] ? parts[src + 1] : "(project)";
  }

  function matchesSourceScope(path, scope) {
    // ponytail: path-based source-set scope; parse Gradle variant composition only when exact APK scope is required.
    const sourceSet = inferSourceSet(path);
    if (scope === "all") return true;
    if (scope && scope.startsWith("source:")) {
      const selected = scope.slice(7);
      return sourceSet === "main" || sourceSet === selected;
    }
    return sourceSet === "main";
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function parseCustomClasses(value) {
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function maskCode(text) {
    let out = "";
    let state = "code";
    let quote = "";

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1] || "";

      if (state === "line") {
        if (ch === "\n") {
          state = "code";
          out += "\n";
        } else {
          out += " ";
        }
        continue;
      }

      if (state === "block") {
        if (ch === "*" && next === "/") {
          out += "  ";
          i += 1;
          state = "code";
        } else {
          out += ch === "\n" ? "\n" : " ";
        }
        continue;
      }

      if (state === "string") {
        if (quote === "\"\"\"" && ch === "\"" && next === "\"" && text[i + 2] === "\"") {
          out += "   ";
          i += 2;
          state = "code";
        } else if (quote !== "\"\"\"" && ch === "\\") {
          out += "  ";
          i += 1;
        } else if (quote !== "\"\"\"" && ch === quote) {
          out += " ";
          state = "code";
        } else {
          out += ch === "\n" ? "\n" : " ";
        }
        continue;
      }

      if (ch === "/" && next === "/") {
        out += "  ";
        i += 1;
        state = "line";
      } else if (ch === "/" && next === "*") {
        out += "  ";
        i += 1;
        state = "block";
      } else if (ch === "\"" && next === "\"" && text[i + 2] === "\"") {
        out += "   ";
        i += 2;
        state = "string";
        quote = "\"\"\"";
      } else if (ch === "\"" || ch === "'" || ch === "`") {
        out += " ";
        state = "string";
        quote = ch;
      } else {
        out += ch;
      }
    }

    return out;
  }

  function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\n") starts.push(i + 1);
    }
    return starts;
  }

  function lineAt(starts, index) {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (starts[mid] <= index && (mid === starts.length - 1 || starts[mid + 1] > index)) return mid;
      if (starts[mid] > index) high = mid - 1;
      else low = mid + 1;
    }
    return 0;
  }

  function isDeadCondition(condition) {
    const value = String(condition || "").trim();
    return /^(false|0)$/i.test(value) || /(?:^|&&)\s*(?:false|0)\s*(?:&&|$)/i.test(value);
  }

  function isGuardCondition(condition) {
    const value = String(condition || "");
    const name = "(?:BuildConfig\\.DEBUG|DEBUG|ENABLE_LOG|LOGGABLE|isLoggable|isDebug|debuggable)";
    if (!new RegExp("\\b" + name + "\\b", "i").test(value)) return false;
    return !new RegExp("!\\s*" + name + "\\b|\\b" + name + "\\s*==\\s*(?:false|0)", "i").test(value);
  }

  function conditionBefore(prefix, keyword) {
    const re = new RegExp("\\b" + keyword + "\\s*\\(([^\\n{}]*)\\)\\s*\\{?\\s*$");
    const match = prefix.match(re);
    return match ? match[1] : "";
  }

  function blockHint(prefix) {
    const tail = prefix.slice(-260);
    const ifCondition = conditionBefore(tail, "if");
    const forCondition = conditionBefore(tail, "for");
    const whileCondition = conditionBefore(tail, "while");
    const loopCondition = forCondition || whileCondition;
    const hint = {};

    if (ifCondition) {
      if (isDeadCondition(ifCondition)) {
        hint.category = "dead";
        hint.reason = "if(false/0) 分支";
        hint.confidence = "high";
      } else if (isGuardCondition(ifCondition)) {
        hint.category = "blocked";
        hint.reason = "Debug/Loggable 条件屏蔽";
        hint.confidence = "medium";
      }
    }

    const forGuard = forCondition.split(";")[1] || "";
    if (!hint.category && (isDeadCondition(whileCondition) || isDeadCondition(forGuard))) {
      hint.category = "dead";
      hint.reason = "不会执行的循环分支";
      hint.confidence = "high";
    }

    if (loopCondition || /\bdo\s*$/.test(tail)) hint.loop = true;
    return hint;
  }

  function buildLineContexts(masked) {
    const lines = masked.split(/\r?\n/);
    const root = { category: "effective", reason: "", confidence: "high", loop: false, terminal: false };
    const stack = [root];
    const contexts = [];
    let pending = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const leadingClose = line.match(/^\s*}+/);
      const startAt = leadingClose ? leadingClose[0].lastIndexOf("}") + 1 : 0;
      if (leadingClose) {
        for (let n = 0; n < leadingClose[0].split("}").length - 1; n += 1) {
          if (stack.length > 1) stack.pop();
        }
      }

      contexts[i] = { ...stack[stack.length - 1] };

      for (let p = startAt; p < line.length; p += 1) {
        const ch = line[p];
        if (ch === "{") {
          const parent = stack[stack.length - 1];
          const hint = Object.keys(pending || {}).length ? pending : blockHint(line.slice(0, p));
          stack.push({
            category: hint.category || parent.category,
            reason: hint.reason || parent.reason,
            confidence: hint.confidence || parent.confidence,
            loop: Boolean(parent.loop || hint.loop),
            terminal: false
          });
          pending = null;
        } else if (ch === "}") {
          if (stack.length > 1) stack.pop();
        }
      }

      if (!line.includes("{")) pending = blockHint(line);
      if (/^\s*(?:return(?:@\w+)?|throw|break(?:@\w+)?|continue(?:@\w+)?)\b/.test(line)) {
        stack[stack.length - 1].terminal = true;
      }
    }

    return contexts;
  }

  function importedAndroidLogMethods(masked) {
    const levels = ["v", "d", "i", "w", "e", "wtf", "println"];
    const methods = new Map();
    const re = /^\s*import\s+(?:static\s+)?android\s*\.\s*util\s*\.\s*Log\s*\.\s*(\*|v|d|i|w|e|wtf|println)(?:\s+as\s+([A-Za-z_]\w*))?\s*;?\s*$/gm;
    let match;
    while ((match = re.exec(masked))) {
      if (match[1] === "*") levels.forEach((level) => methods.set(level, level));
      else methods.set(match[2] || match[1], match[1]);
    }
    return methods;
  }

  function patterns(customClasses, loggerObjects, importedMethods) {
    const list = [
      {
        source: "Android Log",
        re: /\b(?:android\s*\.\s*util\s*\.\s*)?Log\s*\.\s*(v|d|i|w|e|wtf|println)\s*\(/g,
        level: (match) => match[1]
      },
      {
        source: "Timber",
        re: /\bTimber\s*\.\s*(v|d|i|w|e|wtf|log)\s*\(/g,
        level: (match) => match[1]
      },
      {
        source: "Timber",
        re: /\bTimber\s*\.\s*tag\s*\([^;]{0,240}?\)\s*\.\s*(v|d|i|w|e|wtf|log)\s*\(/g,
        level: (match) => match[1]
      },
      {
        source: "System.out/err",
        re: /\bSystem\s*\.\s*(?:out|err)\s*\.\s*(print|println|printf)\s*\(/g,
        level: (match) => match[1]
      },
      {
        source: "Logger API",
        re: new RegExp("\\b(?:" + ["\\w*[Ll]ogger\\w*", ...loggerObjects.map(escapeRegExp)].join("|") + ")\\s*\\.\\s*(v|d|i|w|e|wtf|debug|info|warn|warning|error|trace)\\s*\\(", "g"),
        level: (match) => match[1]
      },
      {
        source: "自定义日志方法",
        re: /\b(logV|logD|logI|logW|logE|logDebug|logInfo|logWarn|logError)\s*\(/g,
        level: (match) => match[1].replace(/^log/i, "").slice(0, 1).toLowerCase(),
        bare: true
      }
    ];

    if (importedMethods.size) {
      const names = [...importedMethods.keys()].map(escapeRegExp).join("|");
      list.splice(4, 0, {
        source: "Android Log（静态导入）",
        re: new RegExp("\\b(" + names + ")\\s*\\(", "g"),
        level: (match) => importedMethods.get(match[1]),
        bare: true
      });
    }

    if (customClasses.length) {
      const names = customClasses.map(escapeRegExp).join("|");
      list.push({
        source: "自定义日志类",
        re: new RegExp("\\b(?:" + names + ")\\s*\\.\\s*(v|d|i|w|e|wtf|debug|info|warn|warning|error|trace)\\s*\\(", "gi"),
        level: (match) => match[1]
      });
    }

    return list;
  }

  function extractSnippet(text, index) {
    const limit = Math.min(text.length, index + 520);
    let depth = 0;
    let quote = "";
    let end = limit;

    for (let i = index; i < limit; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === "\"" || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if ((ch === ";" || ch === "\n") && depth <= 0) {
        end = i + 1;
        break;
      }
    }

    return text.slice(index, end).replace(/\s+/g, " ").trim();
  }

  function classify(context, maskedLine, column, snippet) {
    const inline = blockHint(maskedLine.slice(0, column));
    const beforeCall = maskedLine.slice(0, column);
    const terminal = /\b(return|throw|break|continue)\b[^;]*;\s*$/.exec(beforeCall);
    const inlineTerminal = terminal && !/\b(?:if|for|while)\s*\([^)]*\)\s*$/.test(beforeCall.slice(0, terminal.index));
    const effective = {
      category: inline.category || context.category,
      reason: inline.reason || context.reason,
      confidence: inline.confidence || context.confidence
    };

    if (context.terminal || inlineTerminal) {
      effective.category = effective.category === "effective" ? "suspected" : effective.category;
      effective.reason = effective.reason || "同一代码块内位于 return/throw/break/continue 之后";
      effective.confidence = effective.confidence === "high" ? "medium" : effective.confidence;
    }

    if (effective.category === "effective") {
      effective.reason = /Log\.isLoggable|BuildConfig\.DEBUG/.test(snippet) ? "调用处自带日志开关" : "可执行日志调用";
    }

    return effective;
  }

  function normalizeSnippet(snippet) {
    return snippet.replace(/\s+/g, " ").trim();
  }

  function isBareMethodDeclaration(maskedLine, column) {
    const prefix = maskedLine.slice(0, column).trimEnd();
    const token = (prefix.match(/([A-Za-z_$][\w$<>[\].?]*)$/) || [])[1] || "";
    return token === "fun" || /^(?:void|boolean|byte|short|int|long|float|double|char)$/.test(token) || /^[A-Z]/.test(token);
  }

  function markDuplicates(rows) {
    const groups = new Map();
    rows.forEach((row) => {
      row.candidates = row.candidates.filter((item) => item !== "重复日志");
      if (row.category !== "effective") return;
      if (!groups.has(row.duplicateKey)) groups.set(row.duplicateKey, []);
      groups.get(row.duplicateKey).push(row);
    });
    groups.forEach((group) => {
      if (group.length > 1) group.forEach((row) => row.candidates.push("重复日志"));
    });
    return rows;
  }

  function baselineKey(row) {
    return [row.file, row.source, normalizeSnippet(row.snippet)].join("\n");
  }

  function toBaselineJson(rows, metadata) {
    return JSON.stringify({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      project: metadata && metadata.project || "",
      scope: metadata && metadata.scope || "main",
      rows: rows.map((row) => ({ file: row.file, source: row.source, snippet: row.snippet }))
    }, null, 2);
  }

  function parseBaseline(text) {
    const value = String(text || "");
    if (value.length > 25_000_000) throw new Error("基线文件超过 25 MB");
    let data;
    try {
      data = JSON.parse(value);
    } catch (error) {
      throw new Error("基线文件不是有效 JSON");
    }
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.rows)) throw new Error("不支持的基线格式");
    if (data.rows.length > 250_000) throw new Error("基线日志超过 250000 条");
    const rows = data.rows.map((row) => {
      if (!row || typeof row.file !== "string" || typeof row.source !== "string" || typeof row.snippet !== "string") {
        throw new Error("基线包含无效日志记录");
      }
      return { file: row.file, source: row.source, snippet: row.snippet };
    });
    return { schemaVersion: 1, project: String(data.project || ""), scope: String(data.scope || ""), rows };
  }

  function compareBaseline(rows, baselineRows) {
    const remaining = new Map();
    baselineRows.forEach((row) => {
      const key = baselineKey(row);
      remaining.set(key, (remaining.get(key) || 0) + 1);
    });
    let added = 0;
    let existing = 0;
    rows.forEach((row) => {
      const key = baselineKey(row);
      const count = remaining.get(key) || 0;
      row.baselineStatus = count ? "existing" : "new";
      if (count) {
        existing += 1;
        remaining.set(key, count - 1);
      } else {
        added += 1;
      }
    });
    return { added, existing, removed: [...remaining.values()].reduce((sum, count) => sum + count, 0) };
  }

  function paginate(items, page, pageSize) {
    const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 50;
    const pageCount = Math.ceil(items.length / size);
    if (!pageCount) return { items: [], page: 0, pageCount: 0, start: 0, end: 0 };
    const current = Math.min(Math.max(Number(page) || 1, 1), pageCount);
    const start = (current - 1) * size;
    const result = items.slice(start, start + size);
    return { items: result, page: current, pageCount, start: start + 1, end: start + result.length };
  }

  function analyzeText(text, path, options) {
    const customClasses = options && options.scanCustom === false ? [] : parseCustomClasses(options && options.customClasses);
    const masked = maskCode(text);
    const loggerObjects = parseCustomClasses(options && options.loggerObjects || "LOG,LOGGER,log,logger,mLogger");
    const importedMethods = importedAndroidLogMethods(masked);
    const starts = lineStarts(masked);
    const maskedLines = masked.split(/\r?\n/);
    const contexts = buildLineContexts(masked);
    const seen = new Set();
    const rows = [];

    for (const pattern of patterns(customClasses, loggerObjects, importedMethods)) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(masked))) {
        if (seen.has(match.index)) continue;

        const lineIndex = lineAt(starts, match.index);
        const lineStart = starts[lineIndex];
        const column = match.index - lineStart;
        if (pattern.bare && (masked[match.index - 1] === "." || isBareMethodDeclaration(maskedLines[lineIndex] || "", column))) continue;
        seen.add(match.index);
        const snippet = extractSnippet(text, match.index);
        const levelKey = String(pattern.level(match) || "").toLowerCase();
        const status = classify(contexts[lineIndex] || {}, maskedLines[lineIndex] || "", column, snippet);
        const lineLoop = /\b(for|while)\s*\(|\bdo\b/.test((maskedLines[lineIndex] || "").slice(0, column));
        const candidates = [];

        if (status.category === "effective") {
          if ((contexts[lineIndex] && contexts[lineIndex].loop) || lineLoop) candidates.push("循环日志");
          if (/["'`]\s*\+|\+\s*["'`]|\$\w+|\$\{/.test(snippet)) candidates.push("字符串拼接/插值");
          if (/\/src\/main\//i.test("/" + path.replace(/\\/g, "/")) && ["v", "d", "debug", "trace"].includes(levelKey)) {
            candidates.push("主链路 Debug/Verbose");
          }
        }

        rows.push({
          id: path + ":" + (lineIndex + 1) + ":" + match.index,
          category: status.category,
          confidence: status.confidence || "high",
          level: LEVEL_NAME[levelKey] || levelKey.toUpperCase() || "LOG",
          source: pattern.source,
          module: inferModule(path),
          sourceSet: inferSourceSet(path),
          file: path,
          line: lineIndex + 1,
          method: match[0].replace(/\s+/g, ""),
          reason: status.reason || "可执行日志调用",
          snippet,
          duplicateKey: normalizeSnippet(snippet),
          candidates
        });
      }
    }

    return markDuplicates(rows).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  function summarize(rows) {
    const summary = {
      all: rows.length,
      effective: 0,
      blocked: 0,
      dead: 0,
      suspected: 0,
      modules: new Map(),
      files: new Map(),
      sources: new Map(),
      candidates: new Map()
    };

    for (const row of rows) {
      summary[row.category] += 1;
      summary.modules.set(row.module, (summary.modules.get(row.module) || 0) + (row.category === "effective" ? 1 : 0));
      summary.files.set(row.file, (summary.files.get(row.file) || 0) + (row.category === "effective" ? 1 : 0));
      summary.sources.set(row.source, (summary.sources.get(row.source) || 0) + 1);
      if (row.category === "effective") {
        row.candidates.forEach((candidate) => {
          summary.candidates.set(candidate, (summary.candidates.get(candidate) || 0) + 1);
        });
      }
    }

    return summary;
  }

  function toCsv(rows) {
    const headers = ["category", "confidence", "baselineStatus", "level", "source", "module", "sourceSet", "file", "line", "method", "reason", "candidates", "snippet"];
    const cell = (value) => "\"" + String(value == null ? "" : value).replace(/"/g, "\"\"") + "\"";
    return [
      headers.join(","),
      ...rows.map((row) => headers.map((key) => cell(Array.isArray(row[key]) ? row[key].join(";") : row[key])).join(","))
    ].join("\r\n");
  }

  function initApp() {
    const $ = (id) => global.document.getElementById(id);
    const els = {
      files: $("projectFiles"),
      scan: $("scanBtn"),
      export: $("exportBtn"),
      baselineFile: $("baselineFile"),
      baselineExport: $("baselineExportBtn"),
      project: $("projectName"),
      sourceCount: $("sourceCount"),
      status: $("statusText"),
      baselineStatus: $("baselineStatus"),
      budgetStatus: $("budgetStatus"),
      scope: $("sourceScope"),
      rows: $("resultRows"),
      resultCount: $("resultCount"),
      pageInfo: $("pageInfo"),
      prevPage: $("prevPage"),
      nextPage: $("nextPage"),
      moduleRank: $("moduleRank"),
      moduleTotal: $("moduleTotal"),
      fileRank: $("fileRank"),
      fileTotal: $("fileTotal"),
      sourceRank: $("sourceRank"),
      sourceTotal: $("sourceTotal"),
      candidateRank: $("candidateRank"),
      candidateTotal: $("candidateTotal"),
      customClasses: $("customClasses"),
      loggerObjects: $("loggerObjects"),
      scanCustom: $("scanCustom"),
      hideDead: $("hideDead"),
      hideBlocked: $("hideBlocked"),
      onlyNew: $("onlyNew"),
      budget: $("logBudget"),
      search: $("searchInput")
    };
    const metrics = {
      all: $("metricAll"),
      effective: $("metricEffective"),
      blocked: $("metricBlocked"),
      dead: $("metricDead"),
      suspected: $("metricSuspected")
    };
    let allFiles = [];
    let files = [];
    let rows = [];
    let activeCategory = "all";
    let baseline = null;
    let comparison = null;
    let baselineError = "";
    let currentPage = 1;
    const pageSize = 50;

    function addScopeOption(value, label) {
      const option = global.document.createElement("option");
      option.value = value;
      option.textContent = label;
      els.scope.appendChild(option);
    }

    function populateScopes() {
      const sourceSets = [...new Set(allFiles.map((file) => inferSourceSet(file.webkitRelativePath || file.name)))].sort();
      els.scope.innerHTML = "";
      addScopeOption("main", "生产源码（src/main）");
      addScopeOption("all", "全部源码集");
      sourceSets.filter((name) => name !== "main" && name !== "(project)").forEach((name) => {
        addScopeOption("source:" + name, "main + src/" + name);
      });
      els.scope.value = sourceSets.includes("main") ? "main" : "all";
    }

    function applyScope() {
      files = allFiles.filter((file) => matchesSourceScope(file.webkitRelativePath || file.name, els.scope.value));
      els.sourceCount.textContent = files.length + " / " + allFiles.length;
      els.scan.disabled = !files.length;
    }

    function visibleRows() {
      const q = els.search.value.trim().toLowerCase();
      return rows.filter((row) => {
        if (activeCategory !== "all" && row.category !== activeCategory) return false;
        if (els.hideDead.checked && row.category === "dead") return false;
        if (els.hideBlocked.checked && row.category === "blocked") return false;
        if (els.onlyNew.checked && row.baselineStatus !== "new") return false;
        if (!q) return true;
        return [row.category, row.level, row.source, row.module, row.sourceSet, row.file, row.snippet, row.reason, row.candidates.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
    }

    function renderRank(target, entries, emptyText) {
      target.innerHTML = "";
      if (!entries.length) {
        const li = global.document.createElement("li");
        li.innerHTML = "<span class=\"muted\">" + emptyText + "</span><strong>0</strong>";
        target.appendChild(li);
        return;
      }
      entries.slice(0, 8).forEach(([name, count]) => {
        const li = global.document.createElement("li");
        const label = global.document.createElement("span");
        const value = global.document.createElement("strong");
        label.textContent = name;
        value.textContent = count;
        li.append(label, value);
        target.appendChild(li);
      });
    }

    function refreshBaseline() {
      if (!baseline) {
        comparison = null;
        rows.forEach((row) => { row.baselineStatus = ""; });
        return;
      }
      comparison = compareBaseline(rows, baseline.rows);
    }

    function downloadText(text, type, name) {
      const blob = new Blob([text], { type });
      const a = global.document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function safeFileName(value) {
      return String(value || "android-project").replace(/[\\/:*?"<>|]+/g, "-");
    }

    function renderGovernance(summary) {
      els.baselineExport.disabled = !rows.length;
      els.onlyNew.disabled = !baseline;
      if (!baseline) els.onlyNew.checked = false;

      els.baselineStatus.className = "";
      els.baselineStatus.title = "";
      if (baselineError) {
        els.baselineStatus.textContent = baselineError;
        els.baselineStatus.className = "status-error";
      } else if (!baseline) {
        els.baselineStatus.textContent = "未加载";
      } else {
        const mismatch = baseline.project && els.project.textContent !== "未选择" && baseline.project !== els.project.textContent;
        els.baselineStatus.textContent = (mismatch ? "项目不一致；" : "") + "新增 " + comparison.added + " / 移除 " + comparison.removed;
        els.baselineStatus.className = mismatch ? "status-error" : "";
        els.baselineStatus.title = "已有 " + comparison.existing + " 条；基线范围 " + (baseline.scope || "未记录");
      }

      const rawBudget = els.budget.value.trim();
      els.budgetStatus.className = "";
      if (!rawBudget) {
        els.budgetStatus.textContent = "未设置";
      } else {
        const budget = Number(rawBudget);
        if (!Number.isInteger(budget) || budget < 0) {
          els.budgetStatus.textContent = "预算无效";
          els.budgetStatus.className = "status-error";
        } else if (summary.effective <= budget) {
          els.budgetStatus.textContent = "通过 " + summary.effective + " / " + budget;
          els.budgetStatus.className = "status-ok";
        } else {
          els.budgetStatus.textContent = "超出 " + (summary.effective - budget) + " 条";
          els.budgetStatus.className = "status-over";
        }
      }
    }

    function render() {
      const filtered = visibleRows();
      const summary = summarize(rows);
      renderGovernance(summary);
      Object.keys(metrics).forEach((key) => {
        metrics[key].textContent = summary[key];
      });

      const moduleEntries = [...summary.modules.entries()].filter((item) => item[1] > 0).sort((a, b) => b[1] - a[1]);
      const fileEntries = [...summary.files.entries()].filter((item) => item[1] > 0).sort((a, b) => b[1] - a[1]);
      const sourceEntries = [...summary.sources.entries()].sort((a, b) => b[1] - a[1]);
      const candidateEntries = [...summary.candidates.entries()].sort((a, b) => b[1] - a[1]);
      els.moduleTotal.textContent = moduleEntries.length + " 个模块";
      els.fileTotal.textContent = fileEntries.length + " 个文件";
      els.sourceTotal.textContent = sourceEntries.length + " 种";
      els.candidateTotal.textContent = candidateEntries.reduce((sum, item) => sum + item[1], 0) + " 条";
      renderRank(els.moduleRank, moduleEntries, "暂无模块数据");
      renderRank(els.fileRank, fileEntries, "暂无文件数据");
      renderRank(els.sourceRank, sourceEntries, "暂无识别数据");
      renderRank(els.candidateRank, candidateEntries, "暂无候选项");

      const page = paginate(filtered, currentPage, pageSize);
      currentPage = page.page || 1;
      const shown = page.items;
      els.resultCount.textContent = filtered.length + " 条";
      els.pageInfo.textContent = page.pageCount
        ? "第 " + page.page + " / " + page.pageCount + " 页 · " + page.start + "-" + page.end + " / " + filtered.length + " 条"
        : "第 0 / 0 页 · 0 条";
      els.prevPage.disabled = page.page <= 1;
      els.nextPage.disabled = !page.pageCount || page.page >= page.pageCount;
      els.export.disabled = !filtered.length;
      els.rows.innerHTML = "";
      if (!filtered.length) {
        const tr = global.document.createElement("tr");
        tr.innerHTML = "<td colspan=\"8\" class=\"empty\">没有匹配结果。</td>";
        els.rows.appendChild(tr);
        return;
      }

      shown.forEach((row) => {
        const tr = global.document.createElement("tr");
        tr.innerHTML = [
          "<td><span class=\"pill cat-" + row.category + "\">" + categoryName(row.category) + "</span></td>",
          row.baselineStatus ? "<td><span class=\"pill base-" + row.baselineStatus + "\">" + (row.baselineStatus === "new" ? "新增" : "已有") + "</span></td>" : "<td class=\"muted\">未对比</td>",
          "<td>" + row.level + "</td>",
          "<td>" + escapeHtml(row.source) + "</td>",
          "<td>" + escapeHtml(row.module) + "<div class=\"path\">src/" + escapeHtml(row.sourceSet) + "</div></td>",
          "<td><strong>" + row.line + "</strong><div class=\"path\">" + escapeHtml(row.file) + "</div></td>",
          "<td class=\"code\">" + renderSnippet(row.snippet) + "</td>",
          "<td>" + escapeHtml(row.reason + (row.candidates.length ? " / " + row.candidates.join("、") : "")) + "</td>"
        ].join("");
        els.rows.appendChild(tr);
      });
    }

    function categoryName(category) {
      return {
        effective: "有效",
        blocked: "屏蔽",
        dead: "死代码",
        suspected: "疑似"
      }[category] || "全部";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      }[ch]));
    }

    function renderSnippet(value) {
      const text = String(value);
      const safe = escapeHtml(text);
      if (text.length <= 120) return safe;
      return "<details class=\"code-details\"><summary><code>" + safe + "</code><span class=\"expand-label\">展开</span><span class=\"collapse-label\">收起</span></summary><pre>" + safe + "</pre></details>";
    }

    async function scanProject() {
      if (!files.length) return;
      const scanFiles = files.slice();
      const failures = [];
      rows = [];
      currentPage = 1;
      els.scan.disabled = true;
      els.files.disabled = true;
      els.scope.disabled = true;
      els.export.disabled = true;
      els.baselineFile.disabled = true;
      els.baselineExport.disabled = true;
      els.status.textContent = "扫描中";
      els.status.title = "";
      const options = {
        scanCustom: els.scanCustom.checked,
        customClasses: els.customClasses.value,
        loggerObjects: els.loggerObjects.value
      };

      for (let i = 0; i < scanFiles.length; i += 1) {
        const file = scanFiles[i];
        const path = file.webkitRelativePath || file.name;
        try {
          rows.push(...analyzeText(await file.text(), path, options));
        } catch (error) {
          failures.push(path);
        }
        if (i % 20 === 0 || i === scanFiles.length - 1) {
          els.status.textContent = (i + 1) + " / " + scanFiles.length;
          await new Promise((resolve) => global.setTimeout(resolve, 0));
        }
      }

      markDuplicates(rows);
      refreshBaseline();
      els.status.textContent = failures.length
        ? "完成，扫描 " + scanFiles.length + " 个文件，" + failures.length + " 个读取失败"
        : "完成，扫描 " + scanFiles.length + " 个文件，发现 " + rows.length + " 条日志";
      els.status.title = failures.join("\n");
      els.files.disabled = false;
      els.scope.disabled = false;
      els.baselineFile.disabled = false;
      els.scan.disabled = false;
      render();
    }

    els.files.addEventListener("change", async () => {
      const selected = [...els.files.files];
      allFiles = selected.filter((file) => shouldScanFile(file.webkitRelativePath || file.name));
      const first = selected[0];
      const firstPath = first && (first.webkitRelativePath || first.name);
      els.project.textContent = firstPath ? inferProject(firstPath) : "未选择";
      populateScopes();
      applyScope();
      rows = [];
      currentPage = 1;
      refreshBaseline();
      render();
      if (files.length) await scanProject();
      else els.status.textContent = allFiles.length ? "当前范围没有源码文件" : "目录中没有 Java/Kotlin 源文件";
    });

    els.scope.addEventListener("change", async () => {
      applyScope();
      rows = [];
      currentPage = 1;
      refreshBaseline();
      render();
      if (files.length) await scanProject();
      else els.status.textContent = "当前范围没有源码文件";
    });

    els.scan.addEventListener("click", scanProject);

    els.export.addEventListener("click", () => {
      downloadText("\ufeff" + toCsv(visibleRows()), "text/csv;charset=utf-8", safeFileName(els.project.textContent) + "-logs.csv");
    });

    els.baselineExport.addEventListener("click", () => {
      downloadText(
        toBaselineJson(rows, { project: els.project.textContent, scope: els.scope.value }),
        "application/json;charset=utf-8",
        safeFileName(els.project.textContent) + "-log-baseline.json"
      );
    });

    els.baselineFile.addEventListener("change", async () => {
      const file = els.baselineFile.files[0];
      if (!file) return;
      try {
        baseline = parseBaseline(await file.text());
        baselineError = "";
        refreshBaseline();
      } catch (error) {
        baselineError = "导入失败：" + error.message;
      }
      els.baselineFile.value = "";
      currentPage = 1;
      render();
    });

    global.document.querySelectorAll(".metric").forEach((card) => {
      card.addEventListener("click", () => {
        activeCategory = card.dataset.category;
        global.document.querySelectorAll(".metric").forEach((item) => {
          item.classList.toggle("is-active", item === card);
          item.setAttribute("aria-pressed", item === card ? "true" : "false");
        });
        currentPage = 1;
        render();
      });
    });

    [els.search, els.hideDead, els.hideBlocked, els.onlyNew].forEach((el) => {
      const rerender = () => {
        currentPage = 1;
        render();
      };
      el.addEventListener("input", rerender);
      el.addEventListener("change", rerender);
    });

    els.budget.addEventListener("input", render);
    els.prevPage.addEventListener("click", () => {
      currentPage -= 1;
      render();
    });
    els.nextPage.addEventListener("click", () => {
      currentPage += 1;
      render();
    });

    [els.scanCustom, els.customClasses, els.loggerObjects].forEach((el) => {
      el.addEventListener("input", () => {
        if (!files.length) return;
        els.status.textContent = "扫描规则已更改，请重新扫描";
        els.scan.disabled = false;
      });
    });
  }

  global.LogCounterCore = {
    analyzeText,
    compareBaseline,
    inferSourceSet,
    markDuplicates,
    maskCode,
    matchesSourceScope,
    paginate,
    parseBaseline,
    shouldEnterDirectory,
    shouldScanFile,
    summarize,
    toBaselineJson,
    toCsv
  };

  if (global.document) {
    global.document.addEventListener("DOMContentLoaded", initApp);
  }
})(typeof window !== "undefined" ? window : globalThis);
