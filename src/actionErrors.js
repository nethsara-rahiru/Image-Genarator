import { DestinationBlockedError } from "./security.js";
import { BrowserStartupError } from "./browserErrors.js";
export function actionError(error) {
  if (error instanceof DestinationBlockedError)
    return {
      code: error.code,
      reason: error.reason,
      message:
        error.reason === "PRIVATE_HOSTNAME"
          ? "Local and private hostnames are blocked. Enter a public website address."
          : error.reason === "NO_DNS_ADDRESSES"
            ? "The website hostname returned no IP addresses. Check VPS DNS."
            : "The destination resolves to a private or reserved IP address. Check VPS DNS; public and private mixed answers are blocked.",
    };
  if (error instanceof BrowserStartupError)
    return { code: error.code, message: error.message };
  const text = String(error?.message || error);
  const rules = [
    [
      /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/,
      "DNS_FAILED",
      "The website hostname could not be resolved. Check its spelling and VPS DNS.",
    ],
    [
      /ERR_CERT_|certificate/i,
      "TLS_FAILED",
      "The website certificate could not be verified. Check the site certificate and VPS clock.",
    ],
    [
      /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_INTERNET_DISCONNECTED|ERR_TUNNEL_CONNECTION_FAILED/,
      "CONNECTION_FAILED",
      "The VPS could not connect to the website. Check network access and the destination.",
    ],
    [
      /Private addresses are blocked/,
      "DESTINATION_BLOCKED",
      "Private, local and cloud-metadata network destinations are blocked.",
    ],
    [
      /Only public HTTP|Invalid URL|Enter a URL/,
      "INVALID_ADDRESS",
      "Enter a public HTTP/HTTPS address or Google search terms.",
    ],
    [
      /ERR_BLOCKED_BY_CLIENT/,
      "REQUEST_BLOCKED",
      "Navigation was blocked by the destination security policy. Check the network log.",
    ],
    [
      /Timeout|timed out/,
      "ACTION_TIMEOUT",
      "The page or action timed out. The browser remains available; check the page and network log.",
    ],
    [
      /Target .*closed|browser has been closed|Start the browser first/,
      "BROWSER_CLOSED",
      "No active browser tab is available. Start the browser or open a new tab.",
    ],
    [
      /Tab not found/,
      "TAB_CLOSED",
      "That tab has closed. Choose an existing tab.",
    ],
    [
      /Maximum eight tabs/,
      "TAB_LIMIT",
      "Maximum eight tabs. Close a tab before opening another.",
    ],
    [
      /Input queue full/,
      "INPUT_BUSY",
      "Input queue full. Wait for the current action to finish.",
    ],
    [
      /Session ended/,
      "SESSION_ENDED",
      "Your administrator session ended. Sign in again.",
    ],
    [
      /Unknown action|Invalid coordinates|Invalid scroll|Unsupported key|Text is too long/,
      "INVALID_INPUT",
      "The browser control input was invalid or exceeded its limit.",
    ],
  ];
  for (const [pattern, code, message] of rules)
    if (pattern.test(text)) return { code, message };
  return {
    code: "ACTION_FAILED",
    message:
      "Action failed. Open Debug console for the action ID and diagnostics; run npm run doctor for browser startup failures.",
  };
}
