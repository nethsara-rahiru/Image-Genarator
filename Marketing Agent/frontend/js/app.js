/* Theme: 'system' (default), 'light' or 'dark' */
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try {
  applyTheme(localStorage.getItem("ma_theme"));
} catch {
  /* storage blocked */
}

/* Shared helpers: API client, auth state, nav, utilities */
const esc = (s = "") =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const Auth = {
  _me: undefined,
  async me() {
    if (this._me === undefined) {
      try {
        this._me = (await api("/auth/me")).user;
      } catch {
        this._me = null;
      }
    }
    return this._me;
  },
  async signup(data) {
    this._me = (await api("/auth/signup", { method: "POST", body: data })).user;
  },
  async login(email, password) {
    this._me = (
      await api("/auth/login", { method: "POST", body: { email, password } })
    ).user;
  },
  async logout() {
    await api("/auth/logout", { method: "POST" });
    this._me = null;
  },
};

/* Business logo: uploaded image, or coloured initials */
function logoHTML(biz) {
  if (biz.logo)
    return `<img class="logo" src="${esc(biz.logo)}" alt="${esc(biz.name)} logo">`;
  const initials = (biz.name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  let h = 0;
  for (const c of biz.name || "") h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<div class="logo" style="background:hsl(${h} 45% 36%)" aria-hidden="true">${esc(initials)}</div>`;
}

async function renderNav() {
  const box = document.getElementById("navActions");
  if (!box) return;
  const user = await Auth.me();
  box.innerHTML = user
    ? `<a class="btn btn-ghost" href="dashboard.html">Dashboard</a><button class="btn btn-primary" id="logoutBtn">Log out</button>`
    : `<a class="btn btn-ghost" href="login.html">Log in</a><a class="btn btn-primary" href="signup.html">Sign up</a>`;
  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    await Auth.logout();
    location.href = "index.html";
  });
}

function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2800);
}

document.addEventListener("DOMContentLoaded", renderNav);

/* One-sentence summary of a user's post preferences */
function prefsSummary(p = {}) {
  const tone = { luxury: "premium" }[p.tone] || p.tone || "friendly";
  const freq =
    {
      daily: "every day",
      three_weekly: "3 times a week",
      weekly: "once a week",
    }[p.postFrequency] || "once a week";
  const plats = (
    p.platforms && p.platforms.length ? p.platforms : ["Facebook"]
  ).join(", ");
  return `Posts are written in a ${tone} tone in ${p.language || "English"} for ${plats}, ${freq}.`;
}
