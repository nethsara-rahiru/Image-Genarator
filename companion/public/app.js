let csrf = "";
const notice = (s) => {
  document.querySelector("#notice").textContent = s;
};
async function api(path, body) {
  const response = await fetch("/api" + path, {
    method: body ? "POST" : "GET",
    headers: body
      ? { "content-type": "application/json", "x-csrf-token": csrf }
      : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await response.json();
  if (!response.ok) throw new Error(d.error);
  return d;
}
async function render() {
  try {
    const state = await api("/state");
    csrf = state.csrf;
    document.querySelector("#extension-path").textContent =
      state.extensionDirectory;
    document.querySelector("#browsers").textContent = state.browsers.length
      ? state.browsers
          .map(
            (b) => `${b.label} · ${b.online ? "online" : "offline"} · ${b.id}`,
          )
          .join("\n")
      : "No extension profiles registered yet.";

    document.querySelector("#state").textContent = JSON.stringify(
      {
        paired: state.paired,
        server: state.origin,
        executionMode: state.executionMode,
        activeJob: state.activeJob,
        waiting: state.waitReason,
        accounts: state.accounts.map((a) => ({
          email: a.email,
          state: a.state,
        })),
        pendingReview: state.pendingRun,
      },
      null,
      2,
    );
    document.querySelector("#dashboard").href = state.origin || "#";
    if (!document.querySelector("#folder input").matches(":focus"))
      document.querySelector("#folder input").value = state.downloadRoot;
    if (state.caFingerprint)
      notice(`Private CA fingerprint: ${state.caFingerprint}`);
  } catch (e) {
    notice(e.message);
  }
}
document.querySelector("#connect").onsubmit = async (e) => {
  e.preventDefault();
  e.submitter.disabled = true;
  try {
    const f = new FormData(e.target);
    const file = e.target.ca.files[0];
    await api("/connect", {
      origin: f.get("origin"),
      code: f.get("code"),
      ca: file ? await file.text() : "",
    });
    e.target.code.value = "";
    notice("Computer paired. Register your extension next.");
    await render();
  } catch (err) {
    notice(err.message);
  } finally {
    e.submitter.disabled = false;
  }
};
document.querySelector("#pair-extension").onclick = async () => {
  try {
    const d = await api("/extension-pair", {});
    document.querySelector("#pair-code").textContent = d.code;
  } catch (e) {
    notice(e.message);
  }
};
document.querySelector("#folder").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/download-folder", { directory: e.target.directory.value });
    notice("Downloads folder saved.");
  } catch (err) {
    notice(err.message);
  }
};
await render();
const stream = new EventSource("/api/events");
stream.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.type === "error") notice(d.data.message);
  if (d.type === "completed")
    notice(
      "Original image uploaded to the VPS. Open Outputs on the dashboard.",
    );
  render();
};
