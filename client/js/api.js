let csrf = "";
export function setCsrf(v) {
  csrf = v;
}
export async function api(path, options = {}) {
  const headers = { "x-csrf-token": csrf, ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const r = await fetch(`/api${path}`, { ...options, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event("unauthorized"));
    throw new Error(data.error?.message || `Request failed (${r.status})`);
  }
  return data;
}
export const post = (p, b = {}) => api(p, { method: "POST", body: b });
export const patch = (p, b) => api(p, { method: "PATCH", body: b });
export const remove = (p) =>
  api(p, { method: "DELETE", body: { confirm: true } });
