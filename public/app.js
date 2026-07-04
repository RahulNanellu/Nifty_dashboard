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

  // ---- wake lock ----
    // ---- wake lock ----
  let wakeLock = null;
  let wakeRequested = false;

  function updateWakeButton() {
    if (!btnWakeLock) return;
    if (wakeLock || wakeRequested) {
      btnWakeLock.classList.add("active");
      btnWakeLock.textContent = "Awake: ON";
    } else {
      btnWakeLock.classList.remove("active");
      btnWakeLock.textContent = "Stay Awake";
    }
  }

  async function enableWakeLock() {
    try {
      if (!("wakeLock" in navigator)) {
        console.log("Wake Lock API not supported");
        setStatus("Wake lock not supported");
        return;
      }

      wakeRequested = true;

      if (wakeLock) {
        updateWakeButton();
        return;
      }

      wakeLock = await navigator.wakeLock.request("screen");
      console.log("Wake Lock enabled");
      setStatus("Screen awake lock ON");

      wakeLock.addEventListener("release", () => {
        console.log("Wake Lock released");
        wakeLock = null;
        setStatus(wakeRequested ? "Wake lock released, will retry" : "Screen awake lock OFF");
        updateWakeButton();
      });

      updateWakeButton();
    } catch (err) {
      console.error("Wake Lock error:", err);
      setStatus("Wake lock failed");
      wakeLock = null;
      updateWakeButton();
    }
  }

  async function disableWakeLock() {
    try {
      wakeRequested = false;
      if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
      console.log("Wake Lock disabled");
      setStatus("Screen awake lock OFF");
      updateWakeButton();
    } catch (err) {
      console.error("Wake Lock release error:", err);
    }
  }

  async function toggleWakeLock() {
    if (wakeLock || wakeRequested) {
      await disableWakeLock();
    } else {
      await enableWakeLock();
    }
  }

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
  const btnWakeLock = qs("btnWakeLock");
  const btnStopLive = qs("btnStopLive");

  const intradayWrap = qs("intradayWrap");
  const tablePlaceholder = qs("tablePlaceholder");

  const cmdButtons = Array.from(document.querySelectorAll("[data-cmd]"));

  // ---- state ----
  let currentView = "log";
  let intradayTab = null;
  let lastColsKey = "";
  let lastTablePayload = null;
  let currentTableName = "intraday_public";
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

      if (lastTablePayload) renderIntradayTable(lastTablePayload);
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
    setView("log");

    setRunningTitle(cmd);
    setStatus(`Running: ${cmd} ...`);

    appendLog(`\n>>> RUN: ${cmd}\n`);

    try {
      const out = await postJson(`/run/${cmd}`);
      if (!(out && out.ok)) {
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

    // ---- wake lock reacquire ----
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && wakeRequested) {
      await enableWakeLock();
    }
  });

  window.addEventListener("focus", async () => {
    if (wakeRequested) {
      await enableWakeLock();
    }
  });

  // ---- buttons ----
  btnViewLog.addEventListener("click", () => {
  setView("log");
});

  btnViewTable.addEventListener("click", () => {
    setView("table");
  });

  btnClearLog.addEventListener("click", () => {
    
    logEl.textContent = "";
    setStatus("Idle.");
    setRunningTitle("Idle");
  });

  btnClearTable.addEventListener("click", async () => {
    await enableWakeLock();
    lastTablePayload = null;

    if (intradayTab) {
      intradayTab.destroy();
      intradayTab = null;
    }

    intradayWrap.classList.add("hidden");
    tablePlaceholder.classList.remove("hidden");
    tablePlaceholder.textContent = "Waiting for table data…";
  });

  btnWakeLock.addEventListener("click", async () => {
    await toggleWakeLock();
  });
  btnStopLive.addEventListener("click",  () => {
    
    stopLive();
  });

  cmdButtons.forEach((btn) => {
    btn.addEventListener("click",  () => {
      

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
  if (!payload) return;

  const allowedTables = new Set(["intraday_public", "paper15", "daily15align"]);

  if (!allowedTables.has(payload.name)) return;

  lastTablePayload = payload;
  setStatus(`Table updated: ${payload.name}`);

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
    if (r && !Array.isArray(r) && typeof r === "object") return r;
    if (!Array.isArray(r)) return r;
    if (r.length === colsLen) return r;

    const first = r[0];
    if (typeof first !== "string") return r;

    const tail = r.slice(1);
    const needed = colsLen - tail.length;

    const splitters = [
      (s) => s.split("\t"),
      (s) => s.split("|"),
      (s) => s.split(","),
      (s) => s.trim().split(/\s{2,}/),
      (s) => s.trim().split(/\s+/),
    ];

    for (const sp of splitters) {
      const parts = sp(first).map((x) => String(x ?? "").trim()).filter(Boolean);

      if (parts.length === colsLen) return parts;

      if (parts.length >= needed) {
        const rebuilt = parts.slice(0, needed).concat(tail);
        if (rebuilt.length === colsLen) return rebuilt;
      }
    }

    return r;
  }

  function renderIntradayTable(payload) {
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

    const data = rows.map((r) => {
      if (r && !Array.isArray(r) && typeof r === "object") return r;

      const rr = normalizeRow(r, cols.length);
      const obj = {};
      cols.forEach((c, i) => (obj[c] = rr?.[i] ?? ""));
      return obj;
    });

    const colDefs = cols.map((c) => {
    const colName = String(c);
    const is15m = colName.startsWith("15m ");
    const isNumeric =
      colName.includes("Score") ||
      colName.includes("ADX") ||
      colName.includes("Gap1") ||
      colName.includes("ST%");

    return {
      title: c,
      field: c,
      headerSort: true,
      cssClass: is15m ? "col-15m" : "",
      formatter: (cell) => {
        const value = cell.getValue();

        if (isNumeric) {
          const n = Number(value);
          if (Number.isFinite(n)) return n.toFixed(2);
        }

        return value ?? "";
      },
    };
  });

    const colsKey = cols.join("|");

    intradayWrap.classList.remove("hidden");
    tablePlaceholder.classList.add("hidden");

    if (payload.name !== currentTableName && intradayTab) {
      intradayTab.destroy();
      intradayTab = null;
      lastColsKey = "";
    }

    currentTableName = payload.name || "intraday_public";
    if (!intradayTab) {
      
      intradayTab = new Tabulator("#intradayTable", {
      height: "600px",
      layout: "fitDataFill",
      responsiveLayout: false,
      columnMinWidth: 90,

      rowFormatter: function(row) {
        const data = row.getData();

        const d1 = data["1D Decision"];
        const d15 = data["15m Decision"];

        let bg = "";

        if (d1 === "BUY" && d15 === "BUY") {
          bg = "rgba(34, 197, 94, 0.28)";
        } else if (d1 === "SELL" && d15 === "SELL") {
          bg = "rgba(239, 68, 68, 0.28)";
        }

        row.getCells().forEach((cell) => {
          cell.getElement().style.backgroundColor = bg;
        });
      },

      persistence: true,
      persistenceMode: "local",
      persistenceID: `${currentTableName}_table_v1`,

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
  updateWakeButton();


  const autoDaily15Align = document.getElementById("autoDaily15Align");

setInterval(() => {
  if (!autoDaily15Align || !autoDaily15Align.checked) return;

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();

  // 09:15 to 15:30
  if (mins < 555 || mins > 930) return;

  // run only on 15-min marks
  if (now.getMinutes() % 15 === 0) {
    runCmd("daily15align");
  }
}, 60 * 1000);

})();