import { api, post, patch, remove } from "../api.js";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (v) => (v ? new Date(v).toLocaleString() : "—");
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const empty = (s) => `<div class="empty">${s}</div>`;
const options = (items, key = "_id", label = "email") =>
  items
    .map((i) => `<option value="${esc(i[key])}">${esc(i[label])}</option>`)
    .join("");
let pageNumber = 1;
let lastPage;
let filter = "";
let controller;
function table(headers, rows) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : empty("No records yet.");
}
function events(items) {
  return items.length
    ? items
        .map(
          (e) =>
            `<div class="event"><time>${esc(date(e.createdAt))}</time><div><strong>${esc(e.type)}</strong><br>${esc(e.message)}</div></div>`,
        )
        .join("")
    : empty("No events recorded.");
}
function buttons(id, items) {
  return items
    .map(
      ([action, label, danger]) =>
        `<button class="${danger ? "danger" : "quiet"}" data-action="${action}" data-id="${id}">${label}</button>`,
    )
    .join("");
}
function pager(data) {
  return `<div class="row pagination"><button class="quiet" data-action="prev" ${pageNumber <= 1 ? "disabled" : ""}>Previous</button><span class="muted">Page ${pageNumber} · ${data.total} records</span><button class="quiet" data-action="next" ${pageNumber * data.limit >= data.total ? "disabled" : ""}>Next</button></div>`;
}
function details(data) {
  const d = document.createElement("dialog");
  const h = document.createElement("h2");
  h.textContent = "Record details";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(data, null, 2);
  const b = document.createElement("button");
  b.textContent = "Close";
  b.onclick = () => {
    d.close();
    d.remove();
  };
  d.append(h, pre, b);
  document.body.append(d);
  d.showModal();
}
async function queryAll(path) {
  const result = [];
  for (let p = 1; p <= 100; p++) {
    const data = await api(
      `${path}${path.includes("?") ? "&" : "?"}limit=100&page=${p}`,
    );
    result.push(...data.items);
    if (result.length >= data.total) break;
  }
  return result;
}
export async function renderPage(page, root) {
  if (lastPage !== page) {
    pageNumber = 1;
    filter = "";
    lastPage = page;
  }
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  let data;
  if (page === "overview") {
    const [o, w, h] = await Promise.all([
      api("/overview"),
      api("/worker/status"),
      api("/health"),
    ]);
    root.innerHTML = `<div class="card hero"><div class="eyebrow">YOUR GENERATION WORKSPACE</div><h2>From prompt to saved output.</h2><p class="muted">Manage accounts, follow the queue, and keep every result in one place.</p><a href="#generator">Create a generation →</a></div><div class="stats">${[
      ["Accounts", o.accounts],
      ["Ready", o.readyAccounts],
      ["Queued", o.counts.queued || 0],
      [
        "Running",
        [
          "running",
          "uploading_assets",
          "submitting_prompt",
          "generating",
          "downloading",
        ].reduce((sum, state) => sum + (o.counts[state] || 0), 0),
      ],
      ["Completed", o.counts.completed || 0],
      ["Failed", o.counts.failed || 0],
      ["Needs review", o.counts.needs_review || 0],
    ]
      .map(
        ([l, v]) =>
          `<div class="stat"><span>${l}</span><strong>${v}</strong></div>`,
      )
      .join(
        "",
      )}</div><div class="split"><div class="card"><h2>Recent activity</h2>${events(o.events)}</div><div class="card"><h2>System status</h2><p>Database ${badge(h.status)}</p><p>Worker ${badge(w.online ? "online" : "offline")}</p><p>Active profiles: ${w.profiles}</p>${w.activeJob ? `<p>Active job ${badge(w.activeJob.state)}</p><progress max="100" value="${w.activeJob.progress}"></progress>` : '<p class="muted">No job is running.</p>'}</div></div>`;
  } else if (page === "generator") {
    const accounts = await queryAll("/accounts");
    root.innerHTML = `<div class="split"><form id="generate" class="card"><h2>Create an image job</h2><p class="muted">Gemini may return text or decline a request. One valid image from the current response is saved.</p><label>Google account<select name="accountId" required><option value="">Choose account</option>${options(accounts.filter((a) => !a.disabled))}</select></label><label>Conversation<select name="chatId"><option value="">Create new conversation</option></select></label><label>Prompt<textarea name="prompt" required maxlength="12000" placeholder="Describe what you want Gemini to create…"></textarea></label><label>Reference images / logos<input name="files" type="file" multiple accept="image/png,image/jpeg,image/webp"></label><small>Up to 5 images · 10 MB each · PNG, JPEG, WebP</small><p><button>Queue generation</button></p></form><div class="card"><h2>Job progress</h2><div id="job-progress" class="muted">Submit a job to follow its progress here.</div><p class="info">Jobs run in FIFO order, one at a time. Your browser can close while the worker continues.</p></div></div>`;
    root.querySelector("[name=accountId]").onchange = async (e) => {
      const chats = e.target.value
        ? await queryAll(`/chats?accountId=${e.target.value}`)
        : [];
      root.querySelector("[name=chatId]").innerHTML =
        '<option value="">Create new conversation</option>' +
        options(
          chats.filter((c) => c.status !== "archived"),
          "_id",
          "title",
        );
    };
    let pendingSubmission;
    root.querySelector("form").addEventListener(
      "submit",
      async (e) => {
        e.preventDefault();
        const button = e.submitter;
        document.querySelector("#notice").textContent = "";
        button.disabled = true;
        try {
          const f = new FormData(e.target);
          const files = [...e.target.files.files];
          if (files.length > 5 || files.some((f) => f.size > 10485760))
            throw new Error("At most 5 images, 10 MB each");
          const signature = JSON.stringify({
            accountId: f.get("accountId"),
            chatId: f.get("chatId"),
            prompt: f.get("prompt"),
            files: files.map((v) => [v.name, v.size, v.lastModified]),
          });
          if (!pendingSubmission || pendingSubmission.signature !== signature) {
            let assets = [];
            if (files.length) {
              const upload = new FormData();
              files.forEach((file) => upload.append("files", file));
              assets = (await api("/assets", { method: "POST", body: upload }))
                .items;
            }
            const chatId = f.get("chatId");
            pendingSubmission = {
              signature,
              key: crypto.randomUUID(),
              body: {
                accountId: f.get("accountId"),
                ...(chatId ? { chatId } : {}),
                createNew: !chatId,
                prompt: f.get("prompt"),
                assetIds: assets.map((a) => a._id),
              },
            };
          }
          const j = await api("/generate", {
            method: "POST",
            headers: { "idempotency-key": pendingSubmission.key },
            body: pendingSubmission.body,
          });
          pendingSubmission = undefined;
          const panel = root.querySelector("#job-progress");
          const poll = async () => {
            if (signal.aborted) return;
            try {
              const job = await api(`/jobs/${j._id}`);
              panel.innerHTML = `<p>${esc(job._id)}</p>${badge(job.state)}<progress max="100" value="${job.progress}"></progress>${job.error ? `<p>${esc(job.error.message)}</p>` : ""}<a href="#jobs">Open jobs →</a>`;
              if (
                [
                  "queued",
                  "running",
                  "uploading_assets",
                  "submitting_prompt",
                  "generating",
                  "downloading",
                ].includes(job.state)
              )
                setTimeout(poll, 2000);
            } catch (err) {
              panel.textContent = err.message;
            }
          };
          poll();
        } catch (err) {
          document.querySelector("#notice").textContent = err.message;
        } finally {
          button.disabled = false;
        }
      },
      { signal },
    );
  } else if (page === "accounts") {
    data = await api(`/accounts?page=${pageNumber}`);
    root.innerHTML = `<form class="card row" id="add-account"><label>Google account display email<input type="email" name="email" required></label><button>Add account</button></form><p class="info">Google credentials are entered directly in the temporary browser viewer. Sessions expire after five minutes. Close the viewer using Verify & finish.</p><div class="card">${table(
      ["Account", "Status", "Verified", "Actions"],
      data.items.map(
        (a) =>
          `<tr><td>${esc(a.email)} ${a.disabled ? badge("disabled") : ""}</td><td>${badge(a.state)}</td><td>${esc(date(a.lastVerified))}</td><td>${buttons(
            a._id,
            [
              ["connect", "Connect / reconnect"],
              ["verify", "Verify & finish"],
              ["closeLogin", "Close viewer"],
              [
                a.disabled ? "enable" : "disable",
                a.disabled ? "Enable" : "Disable",
              ],
              ["deleteAccount", "Remove", true],
            ],
          )}</td></tr>`,
      ),
    )}${pager(data)}</div>`;
  } else if (page === "chats") {
    const accounts = await queryAll("/accounts");
    data = await api(
      `/chats?page=${pageNumber}${filter ? "&accountId=" + filter : ""}`,
    );
    root.innerHTML = `<form id="add-chat" class="card row"><label>Account<select name="accountId" required>${options(accounts)}</select></label><label>Local title<input name="title" required maxlength="120"></label><button>Create chat record</button></form><p class="info">New chat records open a Gemini conversation when their first generation runs. Reopen opens a local link. Open remote browser uses the account’s isolated profile in a protected viewer.</p><div class="toolbar"><select id="filter-account"><option value="">All accounts</option>${options(accounts)}</select></div><div class="card">${table(
      ["Title", "Account", "Status", "Conversation", "Actions"],
      data.items.map(
        (c) =>
          `<tr><td>${esc(c.title)}</td><td>${esc(accounts.find((a) => a._id === c.accountId)?.email || c.accountId)}</td><td>${badge(c.status)}</td><td>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Reopen ↗</a>` : "Pending first generation"}</td><td>${buttons(
            c._id,
            [
              ...(c.status === "active" && c.url
                ? [["openChat", "Open remote browser"]]
                : []),
              ["rename", "Rename"],
              ["deleteChat", "Archive", true],
            ],
          )}</td></tr>`,
      ),
    )}${pager(data)}</div>`;
    root.querySelector("#filter-account").value = filter;
  } else if (page === "jobs") {
    data = await api(
      `/jobs?page=${pageNumber}${filter ? "&state=" + filter : ""}`,
    );
    root.innerHTML = `<div class="toolbar"><select id="filter-state"><option value="">All states</option>${["queued", "running", "uploading_assets", "submitting_prompt", "generating", "downloading", "completed", "failed", "cancelled", "needs_login", "needs_review"].map((s) => `<option>${s}</option>`).join("")}</select></div><div class="card">${table(
      ["Job / prompt", "State", "Queue", "Progress", "Actions"],
      data.items.map(
        (j) =>
          `<tr><td class="long"><small>${esc(j._id)}</small><br>${esc(j.prompt.slice(0, 130))}${j.error ? `<p>${esc(j.error.code)}: ${esc(j.error.message)}</p>` : ""}</td><td>${badge(j.state)}</td><td>${j.queuePosition ?? "—"}</td><td>${j.progress}%</td><td>${buttons(j._id, [["jobDetails", "History"], ...(["queued", "running", "uploading_assets", "submitting_prompt", "generating", "downloading"].includes(j.state) ? [["cancel", "Cancel", true]] : []), ...(["failed", "needs_login", "needs_review", "cancelled"].includes(j.state) ? [["retry", "Retry"]] : [])])}</td></tr>`,
      ),
    )}${pager(data)}</div>`;
    root.querySelector("#filter-state").value = filter;
  } else if (page === "outputs") {
    data = await api(`/outputs?page=${pageNumber}`);
    root.innerHTML = `<div class="grid">${data.items.map((o) => `<article class="card output"><a href="/api/outputs/${o._id}/image" target="_blank"><img src="/api/outputs/${o._id}/image" alt="Generated output ${esc(o._id)}" loading="lazy"></a><h3>${esc(o.filename)}</h3><p class="muted">${o.width} × ${o.height} · ${esc(o.format)} · ${(o.bytes / 1024).toFixed(0)} KB</p><div class="row"><a href="/api/outputs/${o._id}/image?download=1">Image ↓</a><a href="/api/outputs/${o._id}/metadata">JSON ↓</a>${buttons(o._id, [["deleteOutput", "Delete", true]])}</div></article>`).join("") || empty("Generated images will appear here.")}</div>${pager(data)}`;
  } else if (page === "monitor") {
    const w = await api("/worker/status");
    const o = await api("/overview");
    root.innerHTML = `<div class="card"><h2>Browser activity ${badge(w.online ? "worker online" : "worker offline")}</h2><p>Active account profiles: ${w.profiles}</p><p>Lease expires: ${esc(date(w.heartbeatExpiry))}</p>${w.activeJob ? `<p>Action ${badge(w.activeJob.state)}</p><progress max="100" value="${w.activeJob.progress}"></progress>` : empty("No active browser generation.")}<p class="info">Monitor captures include only a current-response image crop. Page text, prompts, account controls and login screens are excluded. Interactive login is visible only in your authenticated viewer.</p></div>${w.screenshotAvailable ? `<div class="card"><h2>Latest response image capture</h2><p class="muted">${esc(date(w.screenshotAt))} · Job ${esc(w.screenshotJobId)}</p><img src="/api/worker/screenshot?t=${encodeURIComponent(w.screenshotAt)}" alt="Current response image crop; page and account details excluded"></div>` : ""}<div class="card"><h2>Recent actions and errors</h2>${events(o.events)}</div>`;
  } else if (page === "recovery") {
    data = await api(`/recovery?page=${pageNumber}`);
    const calls = data.events.filter((e) => e.type === "recovery.proposed");
    const tokens = calls.reduce(
      (s, e) =>
        s +
        (Number.isSafeInteger(e.recovery?.usage?.total_tokens)
          ? e.recovery.usage.total_tokens
          : 0),
      0,
    );
    root.innerHTML = `<div class="stats"><div class="stat"><span>Proposals in recent events</span><strong>${calls.length}</strong></div><div class="stat"><span>Failures in recent events</span><strong>${data.events.filter((e) => e.type === "recovery.failed").length}</strong></div><div class="stat"><span>Reported tokens in recent events</span><strong>${tokens}</strong></div></div><div class="card"><h2>Verified locator registry</h2>${table(
      ["Action", "Locator", "Success / failure", "Revision history", "Actions"],
      data.locators.items.map(
        (l) =>
          `<tr><td>${esc(l.action)}</td><td class="long">${esc(l.value)}</td><td>${l.successes} / ${l.failures}</td><td class="long">${l.history.map((h) => `${esc(date(h.at))} · ${esc(h.value)}`).join("<br>")}</td><td>${buttons(l._id, [["rollback", "Rollback"]])}</td></tr>`,
      ),
    )}${pager(data.locators)}</div><div class="card"><h2>Recovery events (latest 100)</h2>${events(data.events)}</div>`;
  } else if (page === "settings") {
    const d = await api("/settings");
    const s = d.settings || {};
    root.innerHTML = `<div class="split"><form id="settings" class="card"><h2>Automation settings</h2><label>Generation timeout (ms)<input name="generationTimeoutMs" type="number" min="30000" max="900000" value="${s.generationTimeoutMs || 240000}" required></label><label>Manual retry limit<input name="retryLimit" type="number" min="0" max="3" value="${s.retryLimit ?? 1}" required></label><label>Retention (days)<input name="retentionDays" type="number" min="1" max="365" value="${s.retentionDays || 30}" required></label><label><input name="groqEnabled" type="checkbox" ${s.groqEnabled ? "checked" : ""}> Enable Groq recovery</label><label>Groq text model<input name="groqModel" value="${esc(s.groqModel || d.groqModel)}" required></label><p class="info">API key ${d.groqKeyConfigured ? "configured" : "not configured"}. Set GROQ_API_KEY in the protected server environment, then restart both processes. Vision recovery is not enabled.</p><button>Save settings</button></form><div><form id="password" class="card"><h2>Change administrator password</h2><label>Current password<input type="password" name="currentPassword" required autocomplete="current-password"></label><label>New password<input type="password" name="newPassword" minlength="14" required autocomplete="new-password"></label><button>Change password & sign out</button></form><div class="card"><h2>Diagnostics</h2><button class="quiet" data-action="diagnostics">Check health</button><p class="muted">${esc(d.storage)}</p></div></div></div>`;
  } else {
    root.innerHTML = empty("Page not found.");
  }
  root.addEventListener(
    "change",
    async (e) => {
      if (["filter-account", "filter-state"].includes(e.target.id)) {
        filter = e.target.value;
        pageNumber = 1;
        await renderPage(page, root);
      }
    },
    { signal },
  );
  root.addEventListener(
    "submit",
    async (e) => {
      if (e.target.id === "generate") return;
      e.preventDefault();
      const b = e.submitter;
      b.disabled = true;
      try {
        const f = Object.fromEntries(new FormData(e.target));
        if (e.target.id === "add-account") await post("/accounts", f);
        if (e.target.id === "add-chat") await post("/chats", f);
        if (e.target.id === "settings")
          await patch("/settings", {
            generationTimeoutMs: Number(f.generationTimeoutMs),
            retryLimit: Number(f.retryLimit),
            retentionDays: Number(f.retentionDays),
            groqEnabled: e.target.groqEnabled.checked,
            groqModel: f.groqModel,
          });
        if (e.target.id === "password") {
          await post("/auth/password", f);
          location.reload();
          return;
        }
        await renderPage(page, root);
      } catch (err) {
        document.querySelector("#notice").textContent = err.message;
        b.disabled = false;
      }
    },
    { signal },
  );
  root.addEventListener(
    "click",
    async (e) => {
      const b = e.target.closest("[data-action]");
      if (!b) return;
      const { action, id } = b.dataset;
      b.disabled = true;
      try {
        if (action === "prev" || action === "next") {
          pageNumber += action === "prev" ? -1 : 1;
        }
        if (action === "connect") {
          const w = window.open("about:blank", "_blank");
          try {
            const d = await post(`/accounts/${id}/login`);
            if (w) w.location = d.viewerUrl;
            else details(d);
          } catch (e) {
            w?.close();
            throw e;
          }
        }
        if (action === "openChat") {
          const w = window.open("about:blank", "_blank");
          try {
            const d = await post(`/chats/${id}/open`);
            if (w) w.location = d.viewerUrl;
            else details(d);
          } catch (e) {
            w?.close();
            throw e;
          }
        }
        if (action === "verify") details(await post(`/accounts/${id}/verify`));
        if (action === "closeLogin") await post(`/accounts/${id}/login/close`);
        if (["enable", "disable"].includes(action))
          await patch(`/accounts/${id}`, { disabled: action === "disable" });
        if (
          action === "deleteAccount" &&
          confirm("Permanently remove this account and its browser profile?")
        )
          await remove(`/accounts/${id}`);
        if (
          action === "deleteChat" &&
          confirm("Archive this local conversation record?")
        )
          await remove(`/chats/${id}`);
        if (action === "rename") {
          const title = prompt("New local title");
          if (title) await patch(`/chats/${id}`, { title });
        }
        if (action === "cancel") await post(`/jobs/${id}/cancel`);
        if (
          action === "retry" &&
          confirm(
            "Inspect the saved conversation first. Retry may generate a duplicate if the previous submission succeeded. Continue?",
          )
        )
          await post(`/jobs/${id}/retry`, { confirm: true });
        if (action === "jobDetails") {
          details(await api(`/jobs/${id}`));
          return;
        }
        if (
          action === "deleteOutput" &&
          confirm("Permanently delete this image and its JSON?")
        )
          await remove(`/outputs/${id}`);
        if (
          action === "rollback" &&
          confirm("Restore the previous verified locator?")
        )
          await post(`/recovery/${id}/rollback`);
        if (action === "diagnostics") {
          details({
            health: await api("/health"),
            worker: await api("/worker/status"),
          });
          return;
        }
        await renderPage(page, root);
      } catch (err) {
        document.querySelector("#notice").textContent = err.message;
      } finally {
        b.disabled = false;
      }
    },
    { signal },
  );
}
