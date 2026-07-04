// server.js
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
const io = new Server(server);

const PORT = 3001;
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- PATHS ----------
const INTRA_DIR = "C:/Rahul_Local/Desktop/MyApps/Nifty_Option_bot";
const INTRA_PYTHON = path.join(INTRA_DIR, ".venv", "Scripts", "python.exe");

const RUN_FULL = path.join(INTRA_DIR, "run_full_workflow.py");
const BUILD_UNIVERSE = path.join(INTRA_DIR, "build_universe_from_daily.py");
const EOD_REPORT = path.join(INTRA_DIR, "eod_report.py");
const LIVE_SCANNER = path.join(INTRA_DIR, "live_scanner.py");
const BACKTESTER = path.join(INTRA_DIR, "backtester.py");
const TOMORROW_PRED = path.join(INTRA_DIR, "tomorrow_predictions.py");

const TRADER_VIEW_JSON = path.join(INTRA_DIR, "logs", "live_scanner", "trader_view_latest.json");
const PAPER15_JSON = path.join(INTRA_DIR, "logs", "live_scanner", "live_15m_paper_latest.json");
const FIB_ANALYSIS_DIR = path.join(INTRA_DIR, "csv", "eod", "analysis");

const DAILY_DIR = "C:/Rahul_Local/Desktop/MyApps/weeklystrategybot";
const DAILY_PYTHON = path.join(DAILY_DIR, ".venv", "Scripts", "python.exe");
const DAILY_SCRIPT = path.join(DAILY_DIR, "daily_strategy_bot.py");
const WEEKLY_SCRIPT = path.join(DAILY_DIR, "weekly_strategy_bot.py");
const DAILY15_ALIGN_SCRIPT = path.join(DAILY_DIR, "daily_15m_alignment_bot.py");
const DAILY15_ALIGN_JSON = path.join(DAILY_DIR, "logs", "daily_15m_alignment_latest.json");

const OPT_DIR = "C:/Rahul_Local/Desktop/MyApps/OptionSellingBot";
const OPT_PYTHON = path.join(OPT_DIR, ".venv", "Scripts", "python.exe");

let liveScannerProcess = null;
const LONG_RUNNING_KEYS = new Set(["live", "live_eod", "paper15_auto"]);

// ---------- MIDDLEWARE ----------
app.use(express.json());
app.use("/fib-reports", express.static(FIB_ANALYSIS_DIR));
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/ping", (req, res) => res.send("pong"));

// ---------- COMMANDS ----------
const COMMANDS = {
  daily: {
    title: "Daily Strategy Bot",
    cmd: DAILY_PYTHON,
    args: [DAILY_SCRIPT],
    cwd: DAILY_DIR,
  },

  daily15align: {
    title: "Daily + 15m Alignment",
    cmd: DAILY_PYTHON,
    args: [DAILY15_ALIGN_SCRIPT],
    cwd: DAILY_DIR,
  },

  weekly: {
    title: "Weekly Strategy Bot",
    cmd: DAILY_PYTHON,
    args: [WEEKLY_SCRIPT],
    cwd: DAILY_DIR,
  },

  tomorrow: {
    title: "Tomorrow Predictions (Next Morning Focus)",
    cmd: INTRA_PYTHON,
    args: [TOMORROW_PRED],
    cwd: INTRA_DIR,
  },

  daily_dbg: {
    title: "Daily Strategy Bot (DEBUG VIEW)",
    cmd: DAILY_PYTHON,
    args: [DAILY_SCRIPT, "--debug"],
    cwd: DAILY_DIR,
    env: { DEBUG_VIEW: "1" },
  },

  weekly_dbg: {
    title: "Weekly Strategy Bot (DEBUG VIEW)",
    cmd: DAILY_PYTHON,
    args: [WEEKLY_SCRIPT, "--debug"],
    cwd: DAILY_DIR,
    env: { DEBUG_VIEW: "1" },
  },

  morning: {
    title: "Option Buying – Full Morning Pipeline",
    cmd: INTRA_PYTHON,
    args: [RUN_FULL],
    cwd: INTRA_DIR,
    env: { RUN_LIVE: "0" },
  },

  universe: {
    title: "Option Buying – Rebuild LIVE_UNIVERSE Only",
    cmd: INTRA_PYTHON,
    args: [BUILD_UNIVERSE],
    cwd: INTRA_DIR,
  },

  eod30: {
    title: "Option Buying – EOD 30m Report",
    cmd: INTRA_PYTHON,
    args: [EOD_REPORT],
    cwd: INTRA_DIR,
  },

  live: {
    title: "Option Buying – Start Live Scanner",
    cmd: INTRA_PYTHON,
    args: ["-u", LIVE_SCANNER],
    cwd: INTRA_DIR,
  },

  live_eod: {
    title: "Live Scanner (EOD Parity: ST3 + EMA50 only)",
    cmd: INTRA_PYTHON,
    args: ["-u", LIVE_SCANNER],
    cwd: INTRA_DIR,
    env: { LIVE_MODE: "EOD_PARITY" },
  },

  paper15: {
    title: "15m Paper Scanner – NIFTY + BANKNIFTY",
    cmd: INTRA_PYTHON,
    args: ["-u", LIVE_SCANNER, "--paper15"],
    cwd: INTRA_DIR,
  },

  paper15_auto: {
    title: "AUTO 15m Paper Scanner – NIFTY + BANKNIFTY",
    cmd: INTRA_PYTHON,
    args: ["-u", LIVE_SCANNER, "--paper15-auto"],
    cwd: INTRA_DIR,
  },

  opt_off: {
    title: "Option Selling Bot (Once, OFFLINE)",
    cmd: OPT_PYTHON,
    args: ["-m", "backend.main", "--once", "--offline"],
    cwd: OPT_DIR,
  },
};

// ---------- JSON TABLE HELPERS ----------
function safeReadJsonArray(filePath, label) {
  try {
    if (!fs.existsSync(filePath)) return [];

    const raw = fs.readFileSync(filePath, "utf8");
    const safe = raw
      .replace(/\bNaN\b/g, "null")
      .replace(/\bInfinity\b/g, "null")
      .replace(/\b-Infinity\b/g, "null");

    const rows = JSON.parse(safe);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    io.emit("log", `[WARN] ${label} read failed: ${e.message}\n`);
    return [];
  }
}

function emitRowsTable(name, objRows, socket = null) {
  if (!objRows || !objRows.length) return;

  const columns = Object.keys(objRows[0]);
  const rows = objRows.map((r) => columns.map((c) => r[c] ?? ""));

  const payload = { name, columns, rows };

  if (socket) socket.emit("table", payload);
  else io.emit("table", payload);
}

function readTraderViewRows() {
  return safeReadJsonArray(TRADER_VIEW_JSON, "trader_view_latest.json");
}

function readPaper15Rows() {
  return safeReadJsonArray(PAPER15_JSON, "live_15m_paper_latest.json");
}

function readDaily15AlignRows() {
  return safeReadJsonArray(DAILY15_ALIGN_JSON, "daily_15m_alignment_latest.json");
}

function emitTraderViewTable() {
  emitRowsTable("intraday_public", readTraderViewRows());
}

function emitPaper15Table() {
  emitRowsTable("paper15", readPaper15Rows());
}

function emitDaily15AlignTable() {
  const rows = readDaily15AlignRows();
  io.emit("log", `[DEBUG] daily15align rows=${rows.length}\n`);
  emitRowsTable("daily15align", rows);
}

// ---------- MORNING COMBO ----------
function runMorningCombo() {
  const step1 = {
    title: "Option Buying – Full Morning Pipeline",
    cmd: INTRA_PYTHON,
    args: [RUN_FULL],
    cwd: INTRA_DIR,
    env: { RUN_LIVE: "0" },
  };

  const step2 = {
    title: "Option Buying – Nifty50 Backtest (Universe)",
    cmd: INTRA_PYTHON,
    args: [BACKTESTER],
    cwd: INTRA_DIR,
  };

  function spawnStep(cfg, onDone) {
    const { title, cmd, args, cwd } = cfg;

    io.emit("log", `\n=== ${title} ===\nCWD : ${cwd}\nCMD : ${cmd} ${args.join(" ")}\n`);

    const mergedEnv = { ...process.env, ...(cfg.env || {}) };
    const child = spawn(cmd, args, { cwd, shell: false, env: mergedEnv });

    child.stdout.on("data", (data) => io.emit("log", data.toString()));
    child.stderr.on("data", (data) => io.emit("log", `[STDERR] ${data.toString()}`));

    child.on("error", (err) => {
      io.emit("log", `[ERROR] ${err.message}\n`);
      onDone && onDone(err, null);
    });

    child.on("close", (code, signal) => {
      io.emit("log", `\n=== ${title} finished with exit code ${code} signal ${signal || "-"} ===\n`);
      onDone && onDone(null, code);
    });
  }

  spawnStep(step1, (err1, code1) => {
    if (err1 || code1 !== 0) {
      io.emit("log", `\n[INFO] Morning pipeline failed, skipping backtest.\n`);
      return;
    }

    spawnStep(step2, (err2, code2) => {
      if (err2 || code2 !== 0) {
        io.emit("log", `\n[INFO] Backtester failed.\n`);
        return;
      }

      const summaryPath = path.join(INTRA_DIR, "backtest_summary_nifty50_30m.csv");

      fs.readFile(summaryPath, "utf8", (err, data) => {
        if (err) {
          io.emit("log", `\n[INFO] Could not read backtest summary CSV: ${err.message}\n`);
          return;
        }

        const lines = data.trim().split(/\r?\n/);
        if (lines.length <= 1) {
          io.emit("log", "\n[INFO] Backtest summary CSV has no rows.\n");
          return;
        }

        io.emit("log", "\n=== TODAY'S TOP OPTION-BUY CANDIDATES (by avg_R) ===\n");
        const maxRows = Math.min(15, lines.length - 1);
        for (let i = 1; i <= maxRows; i++) {
          io.emit("log", lines[i] + "\n");
        }
      });
    });
  });
}

// ---------- RUNNER ----------
function runCommand(key) {
  if (key === "morning") {
    runMorningCombo();
    return;
  }

  const cfg = COMMANDS[key];
  if (!cfg) {
    io.emit("log", `Unknown command: ${key}\n`);
    return;
  }

  if (LONG_RUNNING_KEYS.has(key) && liveScannerProcess && !liveScannerProcess.killed) {
    io.emit("log", "A live scanner is already running.\n");
    return;
  }

  const { title, cmd, args, cwd } = cfg;

  io.emit("log", `\n=== ${title} ===\nCWD : ${cwd}\nCMD : ${cmd} ${args.join(" ")}\n`);

  const mergedEnv = { ...process.env, ...(cfg.env || {}) };
  const child = spawn(cmd, args, { cwd, shell: false, env: mergedEnv });

  if (LONG_RUNNING_KEYS.has(key)) liveScannerProcess = child;

  child.stdout.on("data", (data) => io.emit("log", data.toString()));
  child.stderr.on("data", (data) => io.emit("log", `[STDERR] ${data.toString()}`));

  child.on("error", (err) => {
    io.emit("log", `[ERROR] ${err.message}\n`);
    if (LONG_RUNNING_KEYS.has(key)) liveScannerProcess = null;
  });

  child.on("close", (code, signal) => {
    io.emit("log", `\n=== ${title} finished with exit code ${code} signal ${signal || "-"} ===\n`);

    if (key === "daily15align") {
      io.emit("log", "[DEBUG] emitting daily15align table...\n");
      emitDaily15AlignTable();
    }

    if (LONG_RUNNING_KEYS.has(key)) liveScannerProcess = null;
  });
}

// ---------- ROUTES ----------
app.post("/run/stop_live", (req, res) => {
  if (liveScannerProcess && !liveScannerProcess.killed) {
    io.emit("log", "\nStopping live scanner...\n");

    try {
      liveScannerProcess.kill();
    } catch (e) {
      io.emit("log", `[ERROR] Failed to kill live scanner: ${e.message}\n`);
    }

    liveScannerProcess = null;
    res.json({ ok: true, stopped: true });
    return;
  }

  io.emit("log", "No live scanner process running.\n");
  res.json({ ok: true, stopped: false });
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

// ---------- FILE WATCH ----------
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

let lastPaper15MtimeMs = 0;
setInterval(() => {
  try {
    if (!fs.existsSync(PAPER15_JSON)) return;
    const st = fs.statSync(PAPER15_JSON);
    if (st.mtimeMs > lastPaper15MtimeMs) {
      lastPaper15MtimeMs = st.mtimeMs;
      emitPaper15Table();
    }
  } catch (_) {}
}, 1000);

// ---------- SOCKET ----------
io.on("connection", (socket) => {
  socket.emit("log", "[INFO] Socket connected.\n");

  const traderRows = readTraderViewRows();
  if (traderRows.length) emitRowsTable("intraday_public", traderRows, socket);

  const paperRows = readPaper15Rows();
  if (paperRows.length) emitRowsTable("paper15", paperRows, socket);

  const alignRows = readDaily15AlignRows();
  if (alignRows.length) emitRowsTable("daily15align", alignRows, socket);
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});