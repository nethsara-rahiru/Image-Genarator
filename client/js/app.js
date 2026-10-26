import { api, post, setCsrf } from "./api.js";
import { connectEvents } from "./events.js";
import { renderPage } from "./pages/index.js";
const pages = [
  ["overview", "◈", "Overview"],
  ["generator", "✦", "Generator"],
  ["accounts", "◎", "Accounts"],
  ["devices", "⌘", "Local devices"],
  ["chats", "▤", "Chats"],
  ["jobs", "≡", "Jobs & queue"],
  ["outputs", "▧", "Outputs"],
  ["monitor", "◉", "Browser monitor"],
  ["recovery", "◇", "AI recovery"],
  ["settings", "⚙", "Settings"],
];
let disconnect;
let timer;
export function notice(message) {
  document.querySelector("#notice").textContent = message;
}
export async function render() {
  const page = location.hash.slice(1) || "overview";
  document.querySelector("#title").textContent =
    pages.find((p) => p[0] === page)?.[2] || "Overview";
  for (const a of document.querySelectorAll("nav a"))
    a.classList.toggle("active", a.hash === `#${page}`);
  try {
    const view = document.createElement("section");
    view.id = "content";
    view.innerHTML = '<div class="empty" role="status">Loading…</div>';
    document.querySelector("#content").replaceWith(view);
    await renderPage(page, view);
  } catch (e) {
    notice(e.message);
  }
}
document.querySelector("#nav").innerHTML = pages
  .map(
    ([id, icon, label]) => `<a href="#${id}"><span>${icon}</span>${label}</a>`,
  )
  .join("");
window.addEventListener("hashchange", () => {
  notice("");
  render();
});
window.addEventListener("unauthorized", () => {
  disconnect?.();
  document.querySelector("#login").showModal();
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "login-form") return;
  e.preventDefault();
  try {
    const data = await post(
      "/auth/login",
      Object.fromEntries(new FormData(e.target)),
    );
    setCsrf(data.csrf);
    e.target.reset();
    document.querySelector("#login").close();
    start();
  } catch (err) {
    document.querySelector("#login-error").textContent = err.message;
  }
});
document.querySelector("#logout").onclick = async () => {
  try {
    await post("/auth/logout");
    location.reload();
  } catch (e) {
    notice(e.message);
  }
};
async function start() {
  await render();
  disconnect = connectEvents(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const page = location.hash.slice(1);
      if (
        !["generator", "settings", "accounts", "chats", "devices"].includes(
          page,
        ) &&
        !document.querySelector("input:focus,textarea:focus,select:focus")
      )
        render();
    }, 600);
  });
}
try {
  const me = await api("/auth/me");
  setCsrf(me.csrf);
  if (me.authenticated) start();
  else document.querySelector("#login").showModal();
} catch (e) {
  notice(e.message);
}
setInterval(() => {
  if (
    !document.querySelector("#login").open &&
    ["#overview", "#monitor", "#jobs", "#accounts"].includes(location.hash) &&
    !document.querySelector("input:focus,textarea:focus,select:focus")
  )
    render();
}, 15000);
