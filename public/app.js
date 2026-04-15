(() => {
  function qs(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error("Missing element #" + id);
    return el;
  }

  // sanity checks
  if (typeof io === "undefined") throw new Error("Socket.IO not loaded");
  if (typeof Tabulator === "undefined") throw new Error("Tabulator not loaded");

  const socket = io();

  // ---- UI refs ----
  const logEl = qs("log");
  const statusEl = qs("status");
  const runningTitleEl = qs("runningTitle");

  const logView = qs("logView");
  const tableView = qs("tableView");

  const btnViewLog = qs("btnViewLog");
  const btnViewTable = qs("btnViewTable");
  const btnClearLog = qs("btnClearLog");
  const btnClearTable = qs("btnClearTable");
  const btnStopLive = qs("btnStopLive");

  const intradayWrap = qs("intradayWrap");
  const tablePlaceholder = qs("tablePlaceholder");

  const cmdButtons = Array.from(document.querySelectorAll("[data-cmd]"));

  // ---- state ----
  let currentView = "log";
  let intradayTab = null;
  let lastColsKey = "";
  let lastTablePayload = null;

  // ---- helpers ----
  function appendLog(msg) {
    logEl.textContent += msg;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(txt) {
    statusEl.textContent = txt;
  }

  function setRunningTitle(txt) {
    runningTitleEl.textContent = txt || "Idle";
  }

  function setView(view) {
    currentView = (view === "table") ? "table" : "log";

    if (currentView === "log") {
      logView.classList.remove("hidden");
      tableView.classList.add("hidden");
      btnViewLog.classList.add("active");
      btnViewTable.classList.remove("active");
    } else {
      logView.classList.add("hidden");
      tableView.classList.remove("hidden");
      btnViewLog.classList.remove("active");
      btnViewTable.classList.add("active");

      // if data already arrived, render now (after the view is visible)
      if (lastTablePayload) renderIntradayTable(lastTablePayload);

      // redraw after visible
      setTimeout(() => intradayTab && intradayTab.redraw(true), 80);
    }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json().catch(() => ({}));
  }

  async function runCmd(cmd) {
    // UX: switch to log view whenever you run a job
    setView("log");

    setRunningTitle(cmd);
    setStatus(`Running: ${cmd} ...`);

    appendLog(`\n>>> RUN: ${cmd}\n`);

    try {
      const out = await postJson(`/run/${cmd}`);
      if (out && out.ok) {
        // server logs will stream via socket
      } else {
        appendLog(`[WARN] /run/${cmd} responded, but not ok\n`);
      }
    } catch (e) {
      appendLog(`[ERROR] Failed to start ${cmd}: ${e.message}\n`);
      setStatus("Error.");
      setRunningTitle("Idle");
    }
  }

  async function stopLive() {
    appendLog(`\n>>> STOP LIVE SCANNER\n`);
    try {
      const out = await postJson(`/run/stop_live`);
      if (out?.stopped) {
        appendLog("[INFO] Live scanner stopped.\n");
      } else {
        appendLog("[INFO] No live scanner process running.\n");
      }
    } catch (e) {
      appendLog(`[ERROR] Failed to stop live scanner: ${e.message}\n`);
    }
  }

  // ---- buttons ----
  btnViewLog.addEventListener("click", () => setView("log"));
  btnViewTable.addEventListener("click", () => setView("table"));

  btnClearLog.addEventListener("click", () => {
    logEl.textContent = "";
    setStatus("Idle.");
    setRunningTitle("Idle");
  });

  btnClearTable.addEventListener("click", () => {
    lastTablePayload = null;

    if (intradayTab) {
      intradayTab.destroy();
      intradayTab = null;
    }

    intradayWrap.classList.add("hidden");
    tablePlaceholder.classList.remove("hidden");
    tablePlaceholder.textContent = "Waiting for table data…";
  });

  btnStopLive.addEventListener("click", stopLive);

  cmdButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      // highlight selected command on left
      cmdButtons.forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");

      const cmd = btn.getAttribute("data-cmd");
      if (cmd) runCmd(cmd);
    });
  });

  // ---- socket events ----
  socket.on("connect", () => setStatus("Connected."));
  socket.on("disconnect", () => setStatus("Disconnected."));
  socket.on("log", (msg) => appendLog(msg));

  socket.on("table", (payload) => {
    if (!payload || payload.name !== "intraday_public") return;

    lastTablePayload = payload;

    // Debug (safe)
    console.log("TABLE payload:", {
      name: payload?.name,
      cols: payload?.columns?.length,
      rows: payload?.rows?.length,
      row0: payload?.rows?.[0],
      row0len: Array.isArray(payload?.rows?.[0]) ? payload.rows[0].length : null,
    });

    if (currentView === "table") renderIntradayTable(payload);
  });

  function normalizeRow(r, colsLen) {
  // Accept either array rows or object rows (defensive)
  if (r && !Array.isArray(r) && typeof r === "object") return r;

  if (!Array.isArray(r)) return r;
  if (r.length === colsLen) return r;

  // Common bad case: first cell contains the full row as a single string
  const first = r[0];
  if (typeof first !== "string") return r;

  const tail = r.slice(1);
  const needed = colsLen - tail.length;

  const splitters = [
    (s) => s.split("\t"),
    (s) => s.split("|"),
    (s) => s.split(","),
    (s) => s.trim().split(/\s{2,}/), // fixed-width / pandas-style
    (s) => s.trim().split(/\s+/),    // last resort
  ];

  for (const sp of splitters) {
    const parts = sp(first).map(x => String(x ?? "").trim()).filter(Boolean);

    if (parts.length === colsLen) return parts;

    if (parts.length >= needed) {
      const rebuilt = parts.slice(0, needed).concat(tail);
      if (rebuilt.length === colsLen) return rebuilt;
    }
  }

  return r;
}

function renderIntradayTable(payload) {
  // Must be visible; Tabulator measures width/height
  if (tableView.classList.contains("hidden")) return;

  const cols = payload.columns || [];
  const rows = payload.rows || [];
  if (!cols.length) return;

  console.log(
    "cols=", cols.length,
    "rows=", rows.length,
    "row0=", rows[0],
    "row0len=", Array.isArray(rows[0]) ? rows[0].length : null
  );

  // Build Tabulator data objects
  const data = rows.map((r) => {
    // If server accidentally sent objects instead of arrays
    if (r && !Array.isArray(r) && typeof r === "object") return r;

    const rr = normalizeRow(r, cols.length);
    const obj = {};
    cols.forEach((c, i) => (obj[c] = rr?.[i] ?? ""));
    return obj;
  });

  const colDefs = cols.map((c) => ({
    title: c,
    field: c,
    headerSort: true,
  }));

  const colsKey = cols.join("|");

  // show table container, hide placeholder
  intradayWrap.classList.remove("hidden");
  tablePlaceholder.classList.add("hidden");

  if (!intradayTab) {
    intradayTab = new Tabulator("#intradayTable", {
      height: "600px",
      layout: "fitDataFill",
      responsiveLayout: false,
      columnMinWidth: 90,

      persistence: true,
      persistenceMode: "local",
      persistenceID: "intraday_public_table_v1",

      data,
      columns: colDefs,
      placeholder: "No rows",
    });
    lastColsKey = colsKey;
  } else {
    if (colsKey !== lastColsKey) {
      intradayTab.setColumns(colDefs);
      lastColsKey = colsKey;
    }
    intradayTab.replaceData(data);
  }

  setTimeout(() => intradayTab && intradayTab.redraw(true), 80);
}

  // Force sidebar to start at top on refresh
  const sidebarEl = document.querySelector(".sidebar");
  if (sidebarEl) sidebarEl.scrollTop = 0;

  // init view from URL (?view=table)
  const params = new URLSearchParams(window.location.search);
  setView((params.get("view") || "").toLowerCase() === "table" ? "table" : "log");
})();