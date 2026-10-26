async function open() {
  const url = chrome.runtime.getURL("companion.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url, active: true });
}
chrome.action.onClicked.addListener(open);
chrome.runtime.onInstalled.addListener(open);
chrome.runtime.onStartup.addListener(async () => {
  const saved = await chrome.storage.local.get("bridge");
  if (saved.bridge?.token) await open();
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    message.type !== "openCompanion" ||
    sender.id !== chrome.runtime.id ||
    !sender.tab?.url
  )
    return;
  try {
    const url = new URL(sender.tab.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/"
    )
      return;
  } catch {
    return;
  }
  chrome.storage.local.get("bridge").then((saved) => {
    if (saved.bridge?.token) open();
  });
});
