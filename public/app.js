const $ = (id) => document.getElementById(id);
let csrf = "",
  loggedIn = false,
  ws,
  reconnect,
  delay = 1000,
  current;
let authRequired = true;
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
  $("groq-key").value = "";
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
  $("logout").hidden = !authRequired;
  connect();
  refreshGeneration();
}
async function boot() {
  try {
    const s = await api("/api/session");
    csrf = s.csrf;
    authRequired = s.authRequired;
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
    if (!(event.data instanceof Blob)) {
      const d = JSON.parse(event.data);
      if (d.type === "state") render(d);
      if (d.type === "gemini-flow") renderFlow(d);
      if (d.type === "generation") renderGeneration(d);
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
  if (generationBusy) {
    report("A generation job owns the browser. Finish or cancel it first.");
    return;
  }
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(action));
  else report("Browser connection is offline. Wait for reconnection.");
}
function render(state) {
  current = state;
  $("background-status").textContent = state.backgroundInput
    ? "Background control: private Linux desktop. Keep Node running and the host awake; the browser continues when this dashboard disconnects, until the idle timeout."
    : "Native desktop control requires Chrome visible and can change focus. For background operation, use npm run background with Docker Desktop (see README).";
  $("start").disabled = state.running;
  $("stop").disabled = !state.running;
  for (const id of [
    "new-tab",
    "close-tab",
    "address",
    "go",
    "back",
    "forward",
    "reload",
    "paste",
    "google",
    "google-signin",
    "chrome-console",
  ])
    $(id).disabled = !state.running;
  $("upload").disabled = !state.running;
  $("browser-status").textContent =
    state.message ||
    (state.running
      ? `Desktop Chrome · ${state.width} × ${state.height}`
      : "Browser stopped · local profile saved");
  $("tabs").textContent =
    `Native Chrome · ${state.platform || "OS detected automatically"} · tabs appear in Chrome`;
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
$("close-tab").onclick = () => send({ type: "closeTab" });
$("chrome-console").onclick = () => send({ type: "devtools" });
$("google-signin").onclick = () => {
  report("");
  send({ type: "googleSignIn" });
};
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
        if (confirm(`Delete ${file.name} from this PC?`)) {
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
  $("downloads-toggle").setAttribute(
    "aria-expanded",
    String(!$("downloads-panel").hidden),
  );
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
let geminiFlow = { state: "idle", active: false };

function renderFlow(value) {
  geminiFlow = value;
  const ready = ["signed_in", "already_signed_in"].includes(value.state);
  $("session-badge").textContent = ready
    ? "Signed in"
    : ["awaiting_user", "needs_review"].includes(value.state)
      ? "Action needed"
      : value.active
        ? "Checking…"
        : "Not checked";
  $("session-badge").dataset.state = ready ? "ready" : "pending";
  $("gemini-status").textContent =
    value.message || "Open Gemini in Chrome, then check your sign-in here.";
  $("gemini-start").disabled = !!value.active;
  $("gemini-proceed").hidden = ![
    "awaiting_user",
    "needs_review",
    "awaiting_input",
  ].includes(value.state);
  $("gemini-cancel").hidden = !value.active || value.state === "cancelling";
  const rows = (value.steps || []).map((step) => {
    const row = document.createElement("li");
    row.textContent = `${new Date(step.at).toLocaleTimeString()} — ${step.message}`;
    return row;
  });
  $("gemini-steps").replaceChildren(...rows);
}
for (const command of ["start", "proceed", "cancel"])
  $("gemini-" + command).onclick = async () => {
    const button = $("gemini-" + command);
    button.disabled = true;
    try {
      renderFlow(
        await api("/api/gemini-flow", "POST", { command, id: geminiFlow.id }),
      );
      report("");
    } catch (error) {
      report(error.message);
    } finally {
      button.disabled = command === "start" && !!geminiFlow.active;
    }
  };
$("groq-settings").addEventListener("toggle", async () => {
  if (!$("groq-settings").open || !loggedIn) {
    $("groq-key").value = "";
    return;
  }
  $("groq-model").disabled = true;
  $("groq-save").disabled = true;
  try {
    const data = await api("/api/automation/settings");
    $("groq-model").value = data.model;
    $("groq-status").textContent =
      `${data.configured ? "Configured" : "Not configured"} · ${data.usage.requests} requests · ${data.usage.tokens} reported tokens`;
  } catch (error) {
    report(error.message);
  } finally {
    $("groq-model").disabled = false;
    $("groq-save").disabled = false;
  }
});
$("groq-form").onsubmit = async (event) => {
  event.preventDefault();
  const key = $("groq-key").value,
    model = $("groq-model").value.trim();
  $("groq-key").value = "";
  $("groq-save").disabled = true;
  try {
    const data = await api("/api/automation/settings", "POST", { key, model });
    $("groq-status").textContent = data.configured
      ? "Groq configured. Live model availability is verified only when a recovery call succeeds."
      : "No Groq key configured.";
  } catch (error) {
    report(error.message);
  } finally {
    $("groq-save").disabled = false;
  }
};
let generationBusy = false;
let generationSnapshot = { jobs: [], chats: [] };
let generationRequestKey = crypto.randomUUID();
function renderGeneration(data) {
  generationSnapshot = data;
  generationBusy = data.busy;
  $("generation-status").textContent = data.cleanupError
    ? data.cleanupError
    : data.busy
      ? data.jobs.some(
          (job) => job.browserCleanupPending && job.state === "completed",
        )
        ? "Image saved. Finishing browser cleanup; image downloads are available."
        : "A generation job is running. See its current stage below."
      : "Ready · " +
        data.jobs.filter((j) => j.state === "queued").length +
        " queued · " +
        data.jobs.filter((j) => j.state === "completed").length +
        " completed in recent history";
  const selected = $("generation-chat").value;
  $("generation-chat").replaceChildren(
    new Option("New chat (created by this job)", ""),
    ...data.chats.map(
      (chat) => new Option(chat.title + " · " + chat.id, chat.id),
    ),
  );
  if (data.chats.some((chat) => chat.id === selected))
    $("generation-chat").value = selected;
  $("generation-jobs").setAttribute("aria-busy", "false");
  $("generation-jobs").replaceChildren();
  const filter = $("result-filter").value;
  const visibleJobs = data.jobs.filter((job) =>
    filter === "completed"
      ? job.state === "completed"
      : filter === "attention"
        ? ["failed", "needs_login", "needs_review"].includes(job.state)
        : true,
  );
  for (const job of visibleJobs) {
    const card = document.createElement("article");
    card.className = "generation-job";
    card.dataset.jobId = job.id;
    card.dataset.state = job.state;
    const heading = document.createElement("h3");
    const badge = document.createElement("span");
    badge.className = "job-state";
    badge.textContent = job.state.replaceAll("_", " ");
    const jobId = document.createElement("span");
    jobId.className = "job-id";
    jobId.textContent = job.id;
    heading.append(badge, jobId);
    const prompt = document.createElement("p");
    prompt.textContent = job.promptPreview;
    const progress = document.createElement("progress");
    progress.max = 100;
    progress.value = job.progress;
    progress.setAttribute("aria-label", "Job stage progress");
    const info = document.createElement("p");
    info.className = "muted";
    info.textContent = job.queuePosition
      ? "FIFO queue position: " + job.queuePosition
      : "Attempts: " + job.attempts;
    card.append(heading, prompt, progress, info);
    if (job.chatId) {
      const text = document.createElement("p");
      text.textContent = "Chat ID: " + job.chatId;
      card.append(text);
      const link = document.createElement("a");
      link.href = job.chatUrl;
      link.textContent = "Open Gemini conversation";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }
    if (job.error) {
      const error = document.createElement("p");
      error.className = "error";
      error.textContent = job.error.code + ": " + job.error.message;
      card.append(error);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    const button = (label, operation) => {
      const control = document.createElement("button");
      control.textContent = label;
      control.disabled = !!job.browserCleanupPending;
      control.onclick = async () => {
        control.disabled = true;
        try {
          await api(
            "/api/generation/jobs/" +
              job.id +
              (operation ? "/" + operation : ""),
            operation ? "POST" : "DELETE",
          );
          await refreshGeneration();
        } catch (error) {
          report(error.message);
        } finally {
          control.disabled = false;
        }
      };
      actions.append(control);
    };
    if (
      [
        "queued",
        "running",
        "preparing_prompt",
        "submitting_prompt",
        "generating",
        "downloading",
      ].includes(job.state)
    )
      button("Cancel job", "cancel");
    else {
      if (job.canRecoverDownload) button("Download existing image", "recover");
      if (job.canRecoverDownload) {
        const attach = document.createElement("button");
        attach.textContent = "Attach downloaded image";
        attach.disabled = !!job.browserCleanupPending;
        const file = document.createElement("input");
        file.type = "file";
        file.hidden = true;
        file.setAttribute(
          "aria-label",
          "Original image downloaded manually from this job's Gemini chat",
        );
        attach.onclick = () => file.click();
        file.onchange = async () => {
          if (!file.files[0]) return;
          if (
            !confirm(
              "Confirm this is the original image downloaded from this job's saved Gemini conversation. This is a user-confirmed attachment; the app cannot verify its image association automatically. No prompt will be submitted.",
            )
          ) {
            file.value = "";
            return;
          }
          attach.disabled = true;
          try {
            const body = new FormData();
            body.append("file", file.files[0]);
            body.append("confirmed", "true");
            await api(
              "/api/generation/jobs/" + job.id + "/import",
              "POST",
              body,
            );
            await refreshGeneration();
          } catch (error) {
            report(error.message);
          } finally {
            attach.disabled = false;
            file.value = "";
          }
        };
        actions.append(attach, file);
      }
      if (!job.submissionPossible && job.state !== "completed")
        button("Retry before submission", "retry");
      const remove = document.createElement("button");
      remove.textContent = "Remove local job/output";
      remove.disabled = !!job.browserCleanupPending;
      remove.onclick = async () => {
        if (
          confirm(
            "Remove this local job and its downloaded image? The Gemini chat is retained.",
          )
        ) {
          try {
            await api("/api/generation/jobs/" + job.id, "DELETE");
            await refreshGeneration();
          } catch (error) {
            report(error.message);
          }
        }
      };
      actions.append(remove);
    }
    if (job.state === "completed") {
      const image = document.createElement("img");
      image.src = "/api/generation/jobs/" + job.id + "/image";
      image.alt = "Generated image for " + job.promptPreview;
      image.loading = "lazy";
      image.className = "generation-preview";
      card.append(image);
      const details = document.createElement("p");
      details.textContent =
        job.output.width +
        " × " +
        job.output.height +
        " · " +
        job.output.format +
        " · " +
        job.output.bytes +
        " bytes";
      card.append(details);
      if (job.output.source === "manual_import") {
        const note = document.createElement("p");
        note.className = "muted";
        note.textContent =
          "Manually attached · association confirmed by user, not automatically verified.";
        card.append(note);
      }
      for (const [label, suffix] of [
        ["Download original image", "/image?download=1"],
        ["Download metadata JSON", "/metadata"],
      ]) {
        const link = document.createElement("a");
        link.href = "/api/generation/jobs/" + job.id + suffix;
        link.textContent = label;
        actions.append(link);
      }
    }
    card.append(actions);
    $("generation-jobs").append(card);
  }
  if (!visibleJobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = data.jobs.length
      ? "No matching jobs"
      : "Your next image starts here";
    const hint = document.createElement("p");
    hint.textContent = data.jobs.length
      ? "Choose another filter to see your jobs."
      : "Describe an image and select Generate image. Progress and original downloads will appear here.";
    empty.append(title, hint);
    $("generation-jobs").append(empty);
  }
  $("generation-chats").replaceChildren();
  for (const chat of data.chats) {
    const row = document.createElement("div");
    row.className = "generation-chat";
    const label = document.createElement("p");
    label.textContent = chat.title + " · Chat ID: " + chat.id;
    const rename = document.createElement("button");
    rename.textContent = "Rename locally";
    rename.onclick = async () => {
      const title = prompt("Local chat title", chat.title);
      if (title === null) return;
      try {
        await api(
          "/api/generation/chats/" + encodeURIComponent(chat.id),
          "PATCH",
          { title },
        );
        await refreshGeneration();
      } catch (error) {
        report(error.message);
      }
    };
    row.append(label, rename);
    $("generation-chats").append(row);
  }
  if (!data.chats.length)
    $("generation-chats").textContent =
      "A real chat ID appears after Gemini creates its conversation.";
}
async function refreshGeneration() {
  if (!loggedIn) return;
  try {
    renderGeneration(await api("/api/generation"));
  } catch (error) {
    report(error.message);
  }
}

$("generator-form").onsubmit = async (event) => {
  event.preventDefault();
  $("generate").disabled = true;
  try {
    const job = await api("/api/generation/jobs", "POST", {
      prompt: $("generation-prompt").value,
      chatId: $("generation-chat").value || null,
      idempotencyKey: generationRequestKey,
    });
    generationRequestKey = crypto.randomUUID();
    report("");
    $("generation-status").textContent = "Accepted job " + job.id;
    await refreshGeneration();
  } catch (error) {
    report(error.message);
  } finally {
    $("generate").disabled = false;
  }
};
setInterval(() => {
  if (loggedIn && ws?.readyState !== WebSocket.OPEN) refreshGeneration();
}, 3000);
boot();

$("refresh-results").onclick = refreshGeneration;

$("result-filter").onchange = () => renderGeneration(generationSnapshot);
