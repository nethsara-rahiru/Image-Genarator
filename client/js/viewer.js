import { api, post, setCsrf } from "./api.js";
const id = new URLSearchParams(location.search).get("account");
const canvas = document.querySelector("canvas");
const status = document.querySelector("#status");
let ws;
let finished = false;
try {
  const me = await api("/auth/me");
  if (!me.authenticated) throw new Error("Sign in on dashboard first");
  setCsrf(me.csrf);
  ws = new WebSocket(
    `${location.origin.replace("https:", "wss:")}/viewer?account=${encodeURIComponent(id)}&csrf=${encodeURIComponent(me.csrf)}`,
  );
  ws.binaryType = "blob";
  ws.onopen = () => {
    status.textContent =
      "Connected · Credentials go directly to Google in the remote browser.";
  };
  ws.onclose = () => {
    if (!finished)
      status.textContent =
        "Viewer closed. Return to Accounts to reconnect or verify.";
    canvas.getContext("2d").clearRect(0, 0, 1280, 800);
  };
  ws.onmessage = async (e) => {
    const bitmap = await createImageBitmap(e.data);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
  };
  const send = (v) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(v));
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
    e.preventDefault();
    if (e.ctrlKey && e.key === "a") send({ type: "key", key: "Control+A" });
    else if (
      [
        "Enter",
        "Tab",
        "Backspace",
        "Escape",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
      ].includes(e.key)
    )
      send({ type: "key", key: e.key });
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey)
      send({ type: "text", text: e.key });
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
  document.querySelector("#finish").onclick = async () => {
    try {
      const r = await post(`/accounts/${id}/verify`);
      finished = true;
      status.textContent = r.ready
        ? "Signed-in UI verified. You can close this tab."
        : "Google sign-in not verified. Reconnect from Accounts.";
      ws.close();
      canvas.getContext("2d").clearRect(0, 0, 1280, 800);
    } catch (e) {
      status.textContent = e.message;
    }
  };
} catch (e) {
  status.textContent = e.message;
}
