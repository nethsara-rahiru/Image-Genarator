import { executeTask, abortTask } from "./engine.js";
let settings,
  controller,
  running,
  connecting = false,
  retryTimer;
const status = document.querySelector("#status"),
  activity = document.querySelector("#activity");
function origin(value) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("Use the local companion address http://127.0.0.1:PORT");
  return u.origin;
}
async function request(path, body) {
  const res = await fetch(settings.origin + "/bridge" + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${settings.token}`,
      "x-gemini-extension": chrome.runtime.id,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Local companion request failed");
  return d;
}
const action = (taskId, d) => request("/action", { taskId, ...d });
async function onMessage(m) {
  if (m.type === "tick") {
    await request("/heartbeat", {});
    if (m.currentTask && (!running || running.id !== m.currentTask))
      await request("/result", {
        id: m.currentTask,
        error: {
          code: "LOST_TASK_CONTEXT",
          message: "Browser companion page restarted",
        },
      });
    return;
  }
  if (m.type === "abort") {
    if (running?.id === m.id) {
      abortTask(m.code);
      activity.textContent =
        "Task stopped. Inspect Jobs on the VPS if submission had begun.";
    }
    return;
  }
  if (m.type === "task") {
    if (running) {
      await request("/result", {
        id: m.id,
        error: { code: "LOST_TASK_CONTEXT" },
      });
      return;
    }
    running = m;
    activity.textContent =
      m.task.kind === "job"
        ? `Job ${m.task.job.id} · running in your local browser`
        : `Account action: ${m.task.command.kind}`;
    executeTask(m.task, (d) => action(m.id, d))
      .then((result) => request("/result", { id: m.id, result }))
      .catch((e) =>
        request("/result", {
          id: m.id,
          error: {
            code: e.code || "AUTOMATION",
            message: "Browser operation failed; inspect the Gemini tab",
          },
        }).catch(() => {}),
      )
      .finally(() => {
        running = null;
        activity.textContent = "Ready for the next approved task.";
      });
  }
}
async function connect() {
  if (connecting || !settings?.token) return;
  connecting = true;
  clearTimeout(retryTimer);
  controller?.abort();
  controller = new AbortController();
  try {
    status.textContent = "Connecting to local companion…";
    const response = await fetch(settings.origin + "/bridge/stream", {
      headers: {
        authorization: `Bearer ${settings.token}`,
        "x-gemini-extension": chrome.runtime.id,
      },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error("Extension pairing is no longer valid. Pair again.");
    status.textContent = "Connected. Keep this tab open while jobs run.";
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Companion disconnected");
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1000000)
        throw new Error("Unexpected bridge response");
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        if (line) await onMessage(JSON.parse(line));
      }
    }
  } catch (e) {
    abortTask("LOCAL_DISCONNECTED");
    status.textContent = e.message + " · Reconnecting…";
    retryTimer = setTimeout(connect, 3000);
  } finally {
    connecting = false;
  }
}
document.querySelector("#pair").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const f = new FormData(e.target),
      local = origin(f.get("origin"));
    const saved = await chrome.storage.local.get("instanceId");
    const id = saved.instanceId || crypto.randomUUID();
    const response = await fetch(local + "/bridge/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gemini-extension": chrome.runtime.id,
      },
      body: JSON.stringify({ id, label: f.get("label"), code: f.get("code") }),
    });
    const d = await response.json();
    if (!response.ok) throw new Error(d.error);
    settings = { origin: local, token: d.token };
    await chrome.storage.local.set({ instanceId: id, bridge: settings });
    e.target.code.value = "";
    connect();
  } catch (err) {
    status.textContent = err.message;
  }
};
document.querySelector("#reconnect").onclick = () => connect();
settings = (await chrome.storage.local.get("bridge")).bridge;
if (settings) connect();
