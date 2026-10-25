import { api, post, setCsrf } from "./api.js";
const id = new URLSearchParams(location.search).get("account");
const canvas = document.querySelector("canvas"),
  status = document.querySelector("#status"),
  expiry = document.querySelector("#expiry");
const verification = document.querySelector("#verification-status");
const reasons = {
  expired: "The login session expired. Reconnect from Accounts.",
  verified: "Signed-in UI verified. You can close this tab.",
  cancelled: "The login session was closed from Accounts.",
  browser_closed: "The remote browser stopped. Reconnect from Accounts.",
  profile_lease_lost:
    "The browser lost its profile lease. Check the API events and Atlas connection.",
  shutdown: "The API restarted. Reconnect from Accounts.",
};
let ws,
  finished = false,
  retries = 0,
  reconnectTimer,
  deadline;
function blank() {
  canvas.getContext("2d").clearRect(0, 0, 1280, 800);
}
function end(message) {
  finished = true;
  clearTimeout(reconnectTimer);
  ws?.close();
  blank();
  status.textContent = message;
  document.querySelector("#finish").disabled = true;
  document.querySelector("#open-gemini").disabled = true;
}
async function state() {
  const s = await api(`/accounts/${id}/login/status`);
  if (!s.active) {
    end(
      reasons[s.reason] || "The login session ended. Reconnect from Accounts.",
    );
    return false;
  }
  deadline = Date.now() + s.remainingMs;
  return true;
}
async function connect() {
  if (finished) return;
  clearTimeout(reconnectTimer);
  try {
    if (!(await state())) return;
    const me = await api("/auth/me");
    if (!me.authenticated) {
      end("Sign in to the dashboard again.");
      return;
    }
    setCsrf(me.csrf);
    const socket = new WebSocket(
      `${location.origin.replace("https:", "wss:")}/viewer?account=${encodeURIComponent(id)}&csrf=${encodeURIComponent(me.csrf)}`,
    );
    ws = socket;
    socket.binaryType = "blob";
    socket.onopen = () => {
      retries = 0;
      status.textContent =
        "Connected · Enter Google credentials directly in this remote browser.";
    };
    socket.onmessage = async (e) => {
      if (socket !== ws || finished) return;
      if (typeof e.data === "string") {
        try {
          const s = JSON.parse(e.data);
          if (s.type === "status") status.textContent = s.message;
        } catch {}
        return;
      }
      try {
        const bitmap = await createImageBitmap(e.data);
        if (socket === ws && !finished && socket.readyState === 1) {
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          status.textContent =
            "Connected · Enter Google credentials directly in this remote browser.";
        }
        bitmap.close();
      } catch {
        status.textContent = "Waiting for the next browser frame…";
      }
    };
    socket.onclose = (e) => {
      if (finished || socket !== ws) return;
      blank();
      if (e.code === 4001) {
        end(
          "Your administrator session expired. Sign in to the dashboard again.",
        );
        return;
      }
      if (e.code === 4004) {
        state().catch(() =>
          end("The login session ended. Reconnect from Accounts."),
        );
        return;
      }
      if (retries >= 5) {
        status.textContent =
          "Viewer connection interrupted. Use Reconnect viewer to retry the existing browser.";
        return;
      }
      status.textContent =
        "Viewer connection interrupted. Reconnecting to the existing browser…";
      reconnectTimer = setTimeout(
        connect,
        Math.min(10000, 1000 * 2 ** retries++),
      );
    };
    socket.onerror = () => {};
  } catch (e) {
    status.textContent = e.message;
  }
}
const send = (v) => {
  if (!finished && ws?.readyState === 1) ws.send(JSON.stringify(v));
};
canvas.onclick = (e) => {
  canvas.focus();
  const r = canvas.getBoundingClientRect();
  send({
    type: "click",
    x: ((e.clientX - r.left) * 1280) / r.width,
    y: ((e.clientY - r.top) * 800) / r.height,
  });
};
canvas.onkeydown = (e) => {
  const modifier = e.ctrlKey || e.metaKey;
  if (modifier && e.key.toLowerCase() === "v") return;
  if (modifier && e.key.toLowerCase() === "a") {
    e.preventDefault();
    send({ type: "key", key: "Control+A" });
    return;
  }
  const key = e.key === "Tab" && e.shiftKey ? "Shift+Tab" : e.key;
  if (
    [
      "Enter",
      "Tab",
      "Shift+Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ].includes(key)
  ) {
    e.preventDefault();
    send({ type: "key", key });
  } else if (e.key.length === 1 && !modifier) {
    e.preventDefault();
    send({ type: "text", text: e.key });
  }
};
canvas.onpaste = (e) => {
  e.preventDefault();
  send({ type: "text", text: e.clipboardData.getData("text") });
};
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    send({ type: "scroll", dy: e.deltaY });
  },
  { passive: false },
);
document.querySelector("#reconnect").onclick = () => {
  if (finished) return;
  retries = 0;
  const old = ws;
  ws = null;
  old?.close();
  connect();
};
document.querySelector("#open-gemini").onclick = async (e) => {
  e.target.disabled = true;
  try {
    await post(`/accounts/${id}/login/gemini`);
    verification.textContent =
      "Gemini opened. Wait for the prompt box, then verify.";
  } catch (err) {
    status.textContent = err.message;
  } finally {
    e.target.disabled = false;
  }
};
document.querySelector("#finish").onclick = async (e) => {
  e.target.disabled = true;
  try {
    const r = await post(`/accounts/${id}/verify`);
    if (r.ready) {
      end("Signed-in UI verified. You can close this tab.");
    } else if (r.active) {
      verification.textContent =
        r.message ||
        "Complete Google sign-in and open Gemini before verifying. Your browser remains open.";
    } else {
      end(
        reasons[r.reason] ||
          "Sign-in was not verified. Reconnect from Accounts.",
      );
    }
  } catch (err) {
    verification.textContent = err.message;
  } finally {
    if (!finished) e.target.disabled = false;
  }
};
setInterval(() => {
  if (!finished && deadline) {
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    expiry.textContent = `Time remaining: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    if (!seconds) end(reasons.expired);
  }
}, 1000);
setInterval(() => {
  if (!finished)
    state().catch(() => {
      status.textContent =
        "Unable to check login status. Check dashboard connectivity.";
    });
}, 5000);
await connect();
