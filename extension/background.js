async function open() {
  const url = chrome.runtime.getURL("companion.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url, active: true });
}
chrome.action.onClicked.addListener(open);
chrome.runtime.onInstalled.addListener(open);
