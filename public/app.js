const $ = (id) => document.getElementById(id);
let csrf = "",
  loggedIn = false,
  ws,
  reconnect,
  delay = 1000,
  current;
let intentional = false;
const report = (message) => {
  $("error").textContent = message;
  $("error").hidden = !message;
};
async function api(url, method = "GET", body) {
  const headers = {};
  if (method !== "GET") headers["x-csrf-token"] = csrf;
  if (body && !(body instanceof FormData))
    headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body
      ? body instanceof FormData
        ? body
        : JSON.stringify(body)
      : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && loggedIn) showLogin();
    throw new Error(
      `${data.code ? `${data.code}: ` : ""}${data.error || "Request failed"}${data.debugId ? ` · Action ID: ${data.debugId}` : ""}`,
    );
  }
  return data;
}
function showLogin() {
  loggedIn = false;
  intentional = true;
  clearTimeout(reconnect);
  ws?.close();
  $("login-panel").hidden = false;
  $("workspace").hidden = true;
  $("logout").hidden = true;
  $("connection").textContent = "Signed out";
  logEntries = [];
  logGeneration = null;
  renderLogs();
}
function showWorkspace() {
  loggedIn = true;
  intentional = false;
  $("login-panel").hidden = true;
  $("workspace").hidden = false;
  $("logout").hidden = false;
  connect();
}
async function boot() {
  try {
    const s = await api("/api/session");
    csrf = s.csrf;
    $("setup").hidden = s.configured;
    $("login-form").hidden = !s.configured;
    if (s.authenticated) showWorkspace();
    else showLogin();
  } catch (e) {
    report(e.message);
    $("connection").textContent = "Unavailable";
  }
}
$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  report("");
  const button = e.submitter;
  button.disabled = true;
  try {
    const s = await api("/api/login", "POST", {
      username: $("username").value,
      password: $("password").value,
    });
    csrf = s.csrf;
    showWorkspace();
  } catch (e) {
    report(e.message);
  } finally {
    $("password").value = "";
    button.disabled = false;
  }
};
$("logout").onclick = async () => {
  try {
    await api("/api/logout", "POST");
    showLogin();
    await boot();
  } catch (e) {
    report(e.message);
  }
};
function connect() {
  if (!loggedIn) return;
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/stream`,
  );
  ws.binaryType = "blob";
  ws.onopen = () => {
    $("connection").textContent = "● Connected";
    delay = 1000;
    report("");
  };
  ws.onmessage = async (event) => {
    if (event.data instanceof Blob) {
      try {
        const image = await createImageBitmap(event.data);
        const canvas = $("screen");
        canvas
          .getContext("2d")
          .drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close();
      } catch {}
    } else {
      const d = JSON.parse(event.data);
      if (d.type === "state") render(d);
      if (d.type === "logs") receiveLogs(d);
      if (d.type === "error")
        report(
          `${d.code || "ACTION_FAILED"}: ${d.message}${d.debugId ? ` · Action ID: ${d.debugId}` : ""}`,
        );
    }
  };
  ws.onclose = (event) => {
    if (intentional || !loggedIn) return;
    if (event.code === 4001) {
      showLogin();
      boot();
      return;
    }
    $("connection").textContent = "Reconnecting…";
    reconnect = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10000);
  };
  ws.onerror = () => {
    $("connection").textContent = "Connection lost";
  };
}
function send(action) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(action));
  else report("Browser connection is offline. Wait for reconnection.");
}
function render(state) {
  current = state;
  $("start").disabled = state.running;
  $("stop").disabled = !state.running;
  for (const id of [
    "new-tab",
    "address",
    "go",
    "back",
    "forward",
    "reload",
    "paste",
    "google",
  ])
    $(id).disabled = !state.running;
  $("upload").disabled = !state.uploadReady;
  $("screen").hidden = !state.running || !state.tabs.length;
  $("empty").hidden = state.running && !!state.tabs.length;
  $("browser-status").textContent =
    state.message ||
    (state.running
      ? "Browser running · 1280 × 800"
      : "Browser stopped · session saved");
  if (document.activeElement !== $("address"))
    $("address").value =
      state.tabs
        .find((t) => t.id === state.activeId)
        ?.url.replace(/^about:blank$/, "") || "";
  $("tabs").replaceChildren();
  for (const tab of state.tabs) {
    const item = document.createElement("div");
    item.className = `tab${tab.id === state.activeId ? " active" : ""}`;
    const title = document.createElement("button");
    title.className = "title";
    title.textContent = tab.title || "New tab";
    title.title = tab.url;
    title.setAttribute("role", "tab");
    title.setAttribute("aria-selected", String(tab.id === state.activeId));
    title.onclick = () => send({ type: "selectTab", id: tab.id });
    const close = document.createElement("button");
    close.textContent = "×";
    close.className = "close";
    close.setAttribute("aria-label", `Close ${tab.title || "tab"}`);
    close.onclick = () => send({ type: "closeTab", id: tab.id });
    item.append(title, close);
    $("tabs").append(item);
  }
}
$("start").onclick = async () => {
  $("start").disabled = true;
  report("");
  $("browser-status").textContent = "Starting Chromium…";
  try {
    render(await api("/api/action", "POST", { type: "start" }));
  } catch (e) {
    report(e.message);
    $("start").disabled = false;
  }
};
$("stop").onclick = () => {
  if (
    confirm(
      "Stop the remote browser? Open tabs close; website sessions remain saved.",
    )
  )
    send({ type: "stop" });
};
$("new-tab").onclick = () => send({ type: "newTab" });
$("google").onclick = () => {
  report("");
  send({ type: "navigate", url: "https://www.google.com/" });
};
for (const id of ["back", "forward", "reload"])
  $(id).onclick = () => send({ type: id });
$("navigation").onsubmit = (e) => {
  e.preventDefault();
  const url = $("address").value.trim();
  if (!url) return;
  report("");
  send({ type: "navigate", url });
  $("screen").focus();
};
const canvas = $("screen");
canvas.onclick = (e) => {
  const r = canvas.getBoundingClientRect();
  canvas.focus();
  send({
    type: "click",
    x: ((e.clientX - r.left) * 1280) / r.width,
    y: ((e.clientY - r.top) * 800) / r.height,
    double: e.detail === 2,
  });
};
canvas.oncontextmenu = (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  send({
    type: "click",
    button: "right",
    x: ((e.clientX - r.left) * 1280) / r.width,
    y: ((e.clientY - r.top) * 800) / r.height,
  });
};
let wheelTimer = null,
  wheelX = 0,
  wheelY = 0;
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    wheelX += e.deltaX;
    wheelY += e.deltaY;
    if (!wheelTimer)
      wheelTimer = setTimeout(() => {
        send({ type: "scroll", x: wheelX, y: wheelY });
        wheelX = 0;
        wheelY = 0;
        wheelTimer = null;
      }, 60);
  },
  { passive: false },
);
canvas.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData("text/plain");
  if (text) send({ type: "text", text: text.slice(0, 10000) });
});
canvas.onkeydown = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
  const allowed = [
    "Enter",
    "Tab",
    "Backspace",
    "Delete",
    "Escape",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "F5",
  ];
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
    e.preventDefault();
    send({ type: "text", text: e.key });
    return;
  }
  if (
    allowed.includes(e.key) ||
    ((e.ctrlKey || e.metaKey || e.altKey) && /^[a-z0-9]$/i.test(e.key))
  ) {
    e.preventDefault();
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push("Control");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    send({ type: "key", key: [...mods, e.key].join("+") });
  }
};
$("paste").onclick = () => {
  $("text-value").value = "";
  $("text-dialog").showModal();
  $("text-value").focus();
};
$("text-cancel").onclick = () => $("text-dialog").close();
$("text-form").onsubmit = (e) => {
  e.preventDefault();
  send({ type: "text", text: $("text-value").value });
  $("text-value").value = "";
  $("text-dialog").close();
  canvas.focus();
};
$("upload").onclick = () => $("file").click();
$("file").onchange = async () => {
  const file = $("file").files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    report("Upload exceeds 20 MB");
    return;
  }
  const body = new FormData();
  body.append("file", file);
  $("upload").disabled = true;
  try {
    await api("/api/upload", "POST", body);
    report("");
  } catch (e) {
    report(e.message);
  } finally {
    $("file").value = "";
  }
};
async function downloads() {
  try {
    const files = await api("/api/downloads");
    $("download-list").replaceChildren();
    if (!files.length) {
      $("download-list").textContent = "No completed downloads yet.";
      return;
    }
    for (const file of files) {
      const row = document.createElement("div");
      row.className = "download-row";
      const info = document.createElement("div");
      info.textContent = file.name;
      const size = document.createElement("div");
      size.className = "muted";
      size.textContent = `${(file.bytes / 1024).toFixed(1)} KB · ${new Date(file.created).toLocaleString()}`;
      info.append(size);
      const controls = document.createElement("div");
      controls.className = "actions";
      const link = document.createElement("a");
      link.href = `/api/downloads/${file.id}`;
      link.textContent = "Save to device";
      link.download = file.name;
      const remove = document.createElement("button");
      remove.textContent = "Delete";
      remove.onclick = async () => {
        if (confirm(`Delete ${file.name} from the VPS?`)) {
          try {
            await api(`/api/downloads/${file.id}`, "DELETE");
            await downloads();
          } catch (e) {
            report(e.message);
          }
        }
      };
      controls.append(link, remove);
      row.append(info, controls);
      $("download-list").append(row);
    }
  } catch (e) {
    report(e.message);
  }
}
$("downloads-toggle").onclick = () => {
  $("downloads-panel").hidden = !$("downloads-panel").hidden;
  if (!$("downloads-panel").hidden) downloads();
};
$("refresh-downloads").onclick = downloads;
let logEntries = [],
  logGeneration = null,
  logsPaused = false;
function receiveLogs(snapshot) {
  if (logGeneration !== snapshot.generation) {
    logEntries = [];
    logGeneration = snapshot.generation;
  }
  const known = new Set(logEntries.map((e) => e.id));
  for (const entry of snapshot.entries)
    if (!known.has(entry.id)) {
      logEntries.push(entry);
      known.add(entry.id);
    }
  logEntries = logEntries.slice(-500);
  $("debug-storage").hidden = !snapshot.storageError;
  $("debug-status").textContent =
    `${logEntries.length} retained entries${logsPaused ? " · paused" : ""}`;
  if (!logsPaused) renderLogs();
}
function visibleLogs() {
  const level = $("debug-level").value,
    source = $("debug-source").value,
    query = $("debug-filter").value.trim().toLowerCase();
  return logEntries.filter(
    (e) =>
      (level === "all" || e.level === level) &&
      (source === "all" || e.source === source) &&
      (!query || JSON.stringify(e).toLowerCase().includes(query)),
  );
}
function renderLogs() {
  const entries = visibleLogs();
  $("debug-output").textContent = entries.length
    ? entries
        .map(
          (
            e,
          ) => `${e.timestamp} ${e.level.toUpperCase().padEnd(5)} ${e.source} ${e.code}
  ${e.message}${Object.keys(e.details || {}).length ? ` ${JSON.stringify(e.details)}` : ""}`,
        )
        .join("\n")
    : "No matching events.";
  if ($("debug-follow").checked)
    $("debug-output").scrollTop = $("debug-output").scrollHeight;
}
$("debug-toggle").onclick = async () => {
  $("debug-panel").hidden = !$("debug-panel").hidden;
  $("debug-toggle").setAttribute(
    "aria-expanded",
    String(!$("debug-panel").hidden),
  );
  if (!$("debug-panel").hidden) {
    try {
      receiveLogs(await api("/api/logs"));
    } catch (e) {
      report(e.message);
    }
  }
};
for (const id of ["debug-level", "debug-source", "debug-filter"])
  $(id).addEventListener("input", renderLogs);
$("debug-pause").onclick = () => {
  logsPaused = !logsPaused;
  $("debug-pause").textContent = logsPaused ? "Resume" : "Pause";
  $("debug-status").textContent =
    `${logEntries.length} retained entries${logsPaused ? " · paused" : ""}`;
  if (!logsPaused) renderLogs();
};
$("debug-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("debug-output").textContent);
    $("debug-status").textContent = "Visible log entries copied";
  } catch {
    report(
      "Clipboard unavailable. Select the console text to copy, or use Download logs.",
    );
  }
};
$("debug-clear").onclick = async () => {
  if (confirm("Clear retained debug history on the server?")) {
    try {
      receiveLogs(await api("/api/logs", "DELETE"));
      renderLogs();
    } catch (e) {
      report(e.message);
    }
  }
};
boot();
