if (
  location.hostname === "127.0.0.1" &&
  location.pathname === "/" &&
  document.querySelector('meta[name="gemini-local-companion"][content="1"]')
)
  chrome.runtime.sendMessage({ type: "openCompanion" }).catch(() => {});
