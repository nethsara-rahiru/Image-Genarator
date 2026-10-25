let abortController, activeTab;
const domain = (url) => {
  try {
    const u = new URL(url);
    return (
      u.origin === "https://gemini.google.com" &&
      /^\/app(?:\/[a-zA-Z0-9_-]+)?$/.test(u.pathname) &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
};
export function abortTask(code = "CANCELLED") {
  abortController?.abort(Object.assign(new Error(code), { code }));
  if (activeTab)
    chrome.tabs.sendMessage(activeTab, { type: "abort" }).catch(() => {});
}
function check() {
  if (abortController?.signal.aborted) throw abortController.signal.reason;
}
async function tab(url, activate = false, waitForContent = true) {
  if (!domain(url))
    throw new Error("Only verified Gemini conversation URLs are allowed");
  const saved = await chrome.storage.session.get("managedTabId");
  let t;
  if (saved.managedTabId)
    try {
      t = await chrome.tabs.get(saved.managedTabId);
    } catch {}
  if (t) {
    if (t.url !== url)
      t = await chrome.tabs.update(t.id, { url, active: activate });
    else {
      await chrome.tabs.reload(t.id);
      if (activate) t = await chrome.tabs.update(t.id, { active: true });
    }
  } else {
    t = await chrome.tabs.create({ url, active: true });
    await chrome.storage.session.set({ managedTabId: t.id });
  }
  activeTab = t.id;
  if (!waitForContent) return t.id;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    check();
    const current = await chrome.tabs.get(t.id);
    if (current.status === "complete") {
      try {
        const result = await chrome.tabs.sendMessage(t.id, { type: "ping" });
        if (result?.ok) return t.id;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Object.assign(new Error("Gemini did not load"), {
    code: "NEEDS_LOGIN",
  });
}
async function message(id, data) {
  check();
  const r = await chrome.tabs.sendMessage(id, data);
  if (r?.error)
    throw Object.assign(new Error(r.error.message || r.error.code), {
      code: r.error.code,
    });
  return r;
}
function captureDownload(runId, chatUrl, imageUrl, trigger) {
  return new Promise((resolve, reject) => {
    let selected;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(created);
      chrome.downloads.onChanged.removeListener(changed);
      chrome.downloads.onDeterminingFilename.removeListener(rename);
      abortController?.signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      cleanup();
      reject(abortController.signal.reason);
    };
    const match = (item) => {
      try {
        if (
          item.referrer &&
          domain(item.referrer) &&
          new URL(item.referrer).pathname === new URL(chatUrl).pathname
        )
          return true;
        if (
          item.url === imageUrl &&
          /^data:image\/(png|jpeg|webp);base64,/i.test(imageUrl) &&
          imageUrl.length <= 56 * 1024 * 1024
        )
          return true;
        const u = new URL(item.url);
        return (
          item.url === imageUrl &&
          ((u.protocol === "blob:" &&
            u.origin === "https://gemini.google.com") ||
            (u.protocol === "https:" &&
              (u.hostname === "gemini.google.com" ||
                u.hostname.endsWith(".googleusercontent.com"))))
        );
      } catch {
        return false;
      }
    };
    const rename = (item, suggest) => {
      if (match(item))
        suggest({
          filename: `gemini-agent-${runId}-${item.id}.${/\.jpe?g(?:\?|$)/i.test(item.filename) ? "jpg" : /\.webp(?:\?|$)/i.test(item.filename) ? "webp" : "png"}`,
          conflictAction: "uniquify",
        });
      else suggest();
    };
    const created = (item) => {
      if (!selected && match(item)) selected = item.id;
    };
    const changed = async (delta) => {
      if (delta.id !== selected) return;
      if (delta.error || delta.state?.current === "interrupted") {
        cleanup();
        reject(
          Object.assign(new Error("Download interrupted"), {
            code: "DOWNLOAD_FAILED",
          }),
        );
        return;
      }
      if (delta.state?.current === "complete") {
        cleanup();
        const items = await chrome.downloads.search({ id: selected });
        resolve(items[0].filename);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        Object.assign(new Error("No associated website download"), {
          code: "DOWNLOAD_FAILED",
        }),
      );
    }, 45000);
    chrome.downloads.onDeterminingFilename.addListener(rename);
    chrome.downloads.onCreated.addListener(created);
    chrome.downloads.onChanged.addListener(changed);
    abortController.signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve()
      .then(trigger)
      .catch((e) => {
        cleanup();
        reject(e);
      });
  });
}
export async function executeTask(task, action) {
  abortController = new AbortController();
  try {
    if (task.kind === "control") {
      const c = task.command;
      if (c.kind === "close") {
        const saved = await chrome.storage.session.get("managedTabId");
        if (saved.managedTabId)
          try {
            await chrome.tabs.remove(saved.managedTabId);
          } catch {}
        await chrome.storage.session.remove("managedTabId");
        return { opened: false };
      }
      const id = await tab(
        c.chatUrl || "https://gemini.google.com/app",
        true,
        c.kind === "verify",
      );
      if (c.kind === "verify")
        return { ready: (await message(id, { type: "verify" })).ready };
      return { opened: true };
    }
    const job = task.job;
    const id = await tab(job.chatUrl || "https://gemini.google.com/app", true);
    if (!(await message(id, { type: "verify" })).ready)
      throw Object.assign(
        new Error("Sign in to Gemini in your local browser"),
        { code: "NEEDS_LOGIN" },
      );
    await action({ action: "progress", state: "uploading_assets" });
    await message(id, {
      type: "start",
      runId: job.runId,
      locators: task.locators,
    });
    for (const asset of job.assets) {
      check();
      const data = await action({ action: "asset", assetId: asset.id });
      await message(id, { type: "asset", runId: job.runId, asset: data });
    }
    const relay = async (d) => action(d);
    const listener = (request, sender, sendResponse) => {
      if (
        sender.tab?.id !== id ||
        request.type !== "recovery" ||
        request.runId !== job.runId
      )
        return;
      relay(request.data)
        .then(sendResponse)
        .catch(() => sendResponse({ error: "Recovery failed" }));
      return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    try {
      await message(id, {
        type: "prepare",
        runId: job.runId,
        prompt: job.prompt,
      });
      await action({ action: "progress", state: "submitting_prompt" });
      const permit = await action({ action: "permit" });
      await message(id, {
        type: "submit",
        runId: job.runId,
        expiresAt: permit.expiresAt,
      });
      let current = await chrome.tabs.get(id);
      if (domain(current.url) && new URL(current.url).pathname !== "/app")
        await action({
          action: "progress",
          state: "generating",
          chatUrl: current.url,
        });
      else await action({ action: "progress", state: "generating" });
      const deadline = Date.now() + job.timeoutMs;
      let response;
      while (Date.now() < deadline) {
        check();
        response = await message(id, {
          type: "wait",
          runId: job.runId,
          timeoutMs: Math.min(15000, deadline - Date.now()),
          allowPending: true,
        });
        if (!response.pending) break;
      }
      if (!response?.images) throw new Error("Generation timed out");
      current = await chrome.tabs.get(id);
      if (!domain(current.url) || new URL(current.url).pathname === "/app")
        throw new Error("Conversation URL not verified");
      await action({
        action: "progress",
        state: "downloading",
        chatUrl: current.url,
      });
      for (let index = 0; index < response.images.length; index++) {
        check();
        const filename = await captureDownload(
          job.runId,
          current.url,
          response.images[index],
          () => message(id, { type: "download", runId: job.runId, index }),
        );
        const valid = await action({ action: "download", filename });
        if (valid.valid) return await action({ action: "output", filename });
      }
      throw Object.assign(new Error("No valid image"), { code: "NO_IMAGE" });
    } finally {
      chrome.runtime.onMessage.removeListener(listener);
    }
  } finally {
    abortController = null;
    activeTab = null;
  }
}
