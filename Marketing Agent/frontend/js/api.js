/* All server calls go through api(path, options) -> JSON. Errors throw Error(message). */
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok)
    throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}
