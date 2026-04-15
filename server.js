// server.js
//
// Nifty Bot Dashboard V2

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

console.log("RUNNING SERVER FILE:", __filename);
console.log("CWD:", process.cwd());
console.log(">>> NIFTY DASHBOARD V2 WITH OPTION BUYING + TOMORROW PREDICTIONS <<<");

const app = express();
const server = http.createServer(app);

// (optional) if you ever open from another device in LAN, add cors here
const io = new Server(server /*, { cors: { origin: "*" } } */);

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// ---- track long-running live scanner process ----
let liveScannerProcess = null;

// ---------- PATHS ----------
const INTRA_DIR = "C:\\Users\\Admin\\nifty_option_bot_fixed";
const INTRA_PYTHON = path.join(INTRA_DIR, ".venv", "Scripts", "python.exe");

const RUN_FULL = path.join(INTRA_DIR, "run_full_workflow.py");
const BUILD_UNIVERSE = path.join(INTRA_DIR, "build_universe_from_daily.py");
const EOD_REPORT = path.join(INTRA_DIR, "eod_report.py");
const LIVE_SCANNER = path.join(INTRA_DIR, "live_scanner.py");
const BACKTESTER = path.join(INTRA_DIR, "backtester.py");
const TOMORROW_PRED = path.join(INTRA_DIR, "tomorrow_predictions.py");

const TRADER_VIEW_JSON = path.join(INTRA_DIR, "logs", "live_scanner", "trader_view_latest.json");
const FIB_ANALYSIS_DIR = path.join(INTRA_DIR, "csv", "eod", "analysis");

// Daily / Weekly strategy bot folder
const DAILY_DIR = "C:\\Users\\Admin\\WeeklyStrategyBOT";
const DAILY_PYTHON = path.join(DAILY_DIR, ".venv", "Scripts", "python.exe");
const DAILY_SCRIPT = path.join(DAILY_DIR, "daily_strategy_bot.py");
const WEEKLY_SCRIPT = path.join(DAILY_DIR, "weekly_strategy_bot.py");

// Option Selling bot folder
const OPT_DIR = "C:\\Users\\Admin\\optionsellingbot";
const OPT_PYTHON = path.join(OPT_DIR, ".venv", "Scripts", "python.exe");

// ---------- MIDDLEWARE + STATIC ----------
app.use(express.json());

// serve fib reports
app.use("/fib-reports", express.static(FIB_ANALYSIS_DIR));

// serve UI (index.html, app.js, vendor files)
app.use(express.static(PUBLIC_DIR));

// explicit home route (optional, but nice)
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ping
app.get("/ping", (req, res) => res.send("pong"));

// ---------- COMMAND DEFINITIONS ----------
const COMMANDS = {
  daily: { title: "Daily Strategy Bot", cmd: DAILY_PYTHON, args: [DAILY_SCRIPT], cwd: DAILY_DIR },
  weekly: { title: "Weekly Strategy Bot", cmd: DAILY_PYTHON, args: [WEEKLY_SCRIPT], cwd: DAILY_DIR },
  tomorrow: { title: "Tomorrow Predictions (Next Morning Focus)", cmd: INTRA_PYTHON, args: [TOMORROW_PRED], cwd: INTRA_DIR },

  daily_dbg: { title: "Daily Strategy Bot (DEBUG VIEW)", cmd: DAILY_PYTHON, args: [DAILY_SCRIPT, "--debug"], cwd: DAILY_DIR, env: { DEBUG_VIEW: "1" } },
  weekly_dbg: { title: "Weekly Strategy Bot (DEBUG VIEW)", cmd: DAILY_PYTHON, args: [WEEKLY_SCRIPT, "--debug"], cwd: DAILY_DIR, env: { DEBUG_VIEW: "1" } },

  morning: { title: "Option Buying – Full Morning Pipeline", cmd: INTRA_PYTHON, args: [RUN_FULL], cwd: INTRA_DIR },
  universe: { title: "Option Buying – Rebuild LIVE_UNIVERSE Only", cmd: INTRA_PYTHON, args: [BUILD_UNIVERSE], cwd: INTRA_DIR },

  eod30: { title: "Option Buying – EOD 30m Report", cmd: INTRA_PYTHON, args: [EOD_REPORT], cwd: INTRA_DIR },
  live: { title: "Option Buying – Start Live Scanner (Standalone)", cmd: INTRA_PYTHON, args: ["-u", LIVE_SCANNER], cwd: INTRA_DIR },

  opt_off: { title: "Option Selling Bot (Once, OFFLINE)", cmd: OPT_PYTHON, args: ["-m", "backend.main", "--once", "--offline"], cwd: OPT_DIR },
  live_eod: {
  title: "Live Scanner (EOD Parity: ST3 + EMA50 only)",
  cmd: INTRA_PYTHON,
  args: ["-u", LIVE_SCANNER],
  cwd: INTRA_DIR,
  env: { LIVE_MODE: "EOD_PARITY" },
},

};

// ---------- TABLE HELPERS ----------

function readTraderViewRows() {
  try {
    if (!fs.existsSync(TRADER_VIEW_JSON)) return [];
    const raw = fs.readFileSync(TRADER_VIEW_JSON, "utf8");

    // JSON.parse cannot handle NaN/Infinity. Convert them to null.
    const safe = raw
      .replace(/\bNaN\b/g, "null")
      .replace(/\bInfinity\b/g, "null")
      .replace(/\b-Infinity\b/g, "null");

    const rows = JSON.parse(safe);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    io.emit("log", `[WARN] trader_view_latest.json read/parse failed: ${e.message}\n`);
    return [];
  }
}

function emitTraderViewTable() {
  const objRows = readTraderViewRows();
  if (!objRows.length) return;

  const columns = Object.keys(objRows[0]);
  const rows = objRows.map((r) => columns.map((c) => (r[c] ?? "")));
  io.emit("table", { name: "intraday_public", columns, rows });
}

// If your Python prints a marker block, this parses it.
// Marker format assumption:
// === INTRADAY PUBLIC (LIVE/WATCH) ===
// col1 | col2 | col3
// v1   | v2   | v3
function splitLine(line) {
  if (!line) return [];
  if (line.includes("|")) return line.split("|").map(s => s.trim()).filter(Boolean);
  if (line.includes(",")) return line.split(",").map(s => s.trim());
  return line.split(/\t+|\s{2,}/).map(s => s.trim()).filter(Boolean);
}

function parseIntradayPublicBlock(buf) {
  const marker = "=== INTRADAY PUBLIC (LIVE/WATCH) ===";
  const idx = buf.lastIndexOf(marker);
  if (idx === -1) return null;

  const tail = buf.slice(idx + marker.length);
  const rawLines = tail.split(/\r?\n/).map(l => l.trim());

  // remove blanks at top
  while (rawLines.length && !rawLines[0]) rawLines.shift();

  if (rawLines.length < 2) return null;

  const header = splitLine(rawLines[0]);
  if (!header.length) return null;

  const rows = [];
  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line) continue;
    if (line.startsWith("===")) break;

    const cols = splitLine(line);
    if (!cols.length) continue;

    const row = header.map((_, j) => cols[j] ?? "");
    rows.push(row);
  }

  if (!rows.length) return null;
  return { name: "intraday_public", columns: header, rows };
}

// ---------- MORNING COMBO ----------
function runMorningCombo() {
  const step1 = { title: "Option Buying – Full Morning Pipeline", cmd: INTRA_PYTHON, args: [RUN_FULL], cwd: INTRA_DIR };
  const step2 = { title: "Option Buying – Nifty50 Backtest (Universe)", cmd: INTRA_PYTHON, args: [BACKTESTER], cwd: INTRA_DIR };

  function spawnStep(cfg, onDone) {
    const { title, cmd, args, cwd } = cfg;

    io.emit("log", `\n=== ${title} ===\nCWD : ${cwd}\nCMD : ${cmd} ${args.join(" ")}\n`);

    const mergedEnv = { ...process.env, ...(cfg.env || {}) };
    const child = spawn(cmd, args, { cwd, shell: false, env: mergedEnv });

    child.stdout.on("data", (data) => io.emit("log", data.toString()));
    child.stderr.on("data", (data) => io.emit("log", `[STDERR] ${data.toString()}`));

    child.on("error", (err) => {
      io.emit("log", `[ERROR] ${err.message}\n`);
      onDone && onDone(err);
    });

    child.on("close", (code) => {
      io.emit("log", `\n=== ${title} finished with exit code ${code} ===\n`);
      onDone && onDone(null, code);
    });
  }

  spawnStep(step1, (err1) => {
    if (err1) return io.emit("log", "\n[INFO] Morning pipeline failed, skipping backtest summary.\n");

    spawnStep(step2, (err2) => {
      if (err2) return io.emit("log", "\n[INFO] Backtester failed, cannot show top symbols summary.\n");

      const summaryPath = path.join(INTRA_DIR, "backtest_summary_nifty50_30m.csv");
      fs.readFile(summaryPath, "utf8", (err, data) => {
        if (err) return io.emit("log", `\n[INFO] Could not read backtest summary CSV: ${err.message}\n`);

        const lines = data.trim().split(/\r?\n/);
        if (lines.length <= 1) return io.emit("log", "\n[INFO] Backtest summary CSV has no rows to display.\n");

        io.emit("log", "\n=== TODAY'S TOP OPTION-BUY CANDIDATES (by avg_R) ===\n");
        const maxRows = Math.min(15, lines.length - 1);
        for (let i = 1; i <= maxRows; i++) io.emit("log", lines[i] + "\n");
      });
    });
  });
}

// ---------- RUNNER ----------
function runCommand(key) {
  if (key === "morning") return runMorningCombo();

  const cfg = COMMANDS[key];
  if (!cfg) return io.emit("log", `Unknown command: ${key}\n`);

  if (key === "live" && liveScannerProcess && !liveScannerProcess.killed) {
    return io.emit("log", "Live scanner is already running.\n");
  }

  const { title, cmd, args, cwd } = cfg;
  io.emit("log", `\n=== ${title} ===\nCWD : ${cwd}\nCMD : ${cmd} ${args.join(" ")}\n`);

  const mergedEnv = { ...process.env, ...(cfg.env || {}) };
  const child = spawn(cmd, args, { cwd, shell: false, env: mergedEnv });

  if (key === "live") liveScannerProcess = child;

  
child.stdout.on("data", (data) => {
    const chunk = data.toString();
    io.emit("log", chunk);
  });

  child.stderr.on("data", (data) => io.emit("log", `[STDERR] ${data.toString()}`));

  child.on("error", (err) => {
    io.emit("log", `[ERROR] ${err.message}\n`);
    if (key === "live") liveScannerProcess = null;
  });

  child.on("close", (code) => {
    io.emit("log", `\n=== ${title} finished with exit code ${code} ===\n`);
    if (key === "live") liveScannerProcess = null;
  });
}

// ---------- ROUTES ----------
app.post("/run/stop_live", (req, res) => {
  if (liveScannerProcess && !liveScannerProcess.killed) {
    io.emit("log", "\nStopping live scanner...\n");
    try { liveScannerProcess.kill(); } catch (e) { io.emit("log", `[ERROR] Failed to kill live scanner: ${e.message}\n`); }
    liveScannerProcess = null;
    return res.json({ ok: true, stopped: true });
  }
  io.emit("log", "No live scanner process running.\n");
  return res.json({ ok: true, stopped: false });
});

app.post("/run/:cmd", (req, res) => {
  const key = req.params.cmd;
  runCommand(key);
  res.json({ ok: true, cmd: key });
});

app.post("/run/option_live", (req, res) => {
  const { ticker, fut } = req.body || {};
  const args = ["-m", "backend.main", "--once"];

  if (fut && String(fut).trim()) args.push("--fut", String(fut).trim());
  if (ticker && String(ticker).trim()) args.push("--ticker", String(ticker).trim());

  io.emit("log", `\n=== Option Selling Bot (Once, LIVE via dashboard) ===\nCWD : ${OPT_DIR}\nCMD : ${OPT_PYTHON} ${args.join(" ")}\n`);

  const child = spawn(OPT_PYTHON, args, { cwd: OPT_DIR, shell: false });
  child.stdout.on("data", (data) => io.emit("log", data.toString()));
  child.stderr.on("data", (data) => io.emit("log", `[STDERR] ${data.toString()}`));
  child.on("close", (code) => io.emit("log", `\n=== Option Selling Bot finished with exit code ${code} ===\n`));

  res.json({ ok: true, ticker, fut });
});

// ---------- FILE WATCH (JSON -> table emit) ----------
let lastTraderMtimeMs = 0;

setInterval(() => {
  try {
    if (!fs.existsSync(TRADER_VIEW_JSON)) return;
    const st = fs.statSync(TRADER_VIEW_JSON);
    if (st.mtimeMs > lastTraderMtimeMs) {
      lastTraderMtimeMs = st.mtimeMs;
      emitTraderViewTable();
    }
  } catch (_) {}
}, 1000);

// ---------- SOCKET ----------
io.on("connection", (socket) => {
  socket.emit("log", "[INFO] Socket connected.\n");

  // send latest JSON table immediately if present
  const objRows = readTraderViewRows();
  if (objRows.length) {
    const columns = Object.keys(objRows[0]);
    const rows = objRows.map((r) => columns.map((c) => (r[c] ?? "")));
    socket.emit("table", { name: "intraday_public", columns, rows });
  }
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
