import { nativeError } from "./common.js";
const messages = {
  WINDOW_NOT_READY:
    "No visible window was found for the managed Chrome process. Keep its window open, unminimized and on the current macOS desktop/Space, then retry.",
  FOCUS_DENIED:
    "macOS did not focus the managed Chrome window. Unlock the Mac and check Accessibility access for the app running Node.",
  MAC_AUTOMATION_REQUIRED:
    "Allow the app running Node to control System Events under macOS Privacy & Security → Automation.",
  MAC_ACCESSIBILITY_REQUIRED:
    "Allow the app running Node under macOS Privacy & Security → Accessibility, then restart that terminal if requested.",
  MAC_SCREEN_RECORDING_REQUIRED:
    "Allow the app running Node under macOS Screen Recording (or Screen & System Audio Recording), then restart it if macOS requests this.",
  MAC_CAPTURE_FAILED:
    "The managed Chrome window could not be captured. Check Screen Recording, keep the window unminimized/on the current Space, and run npm run doctor.",
  MAC_WINDOW_QUERY_FAILED:
    "The macOS window-list bridge failed. Run npm run doctor and report its permission/window-query status; this is not proof that a permission is missing.",
  FILE_DIALOG_REQUIRED: "Click a website file picker before uploading.",
  MAC_NATIVE_FAILED:
    "A native macOS helper operation failed. Run npm run doctor for permission and window-query diagnostics.",
  INPUT_DENIED: "The native browser control input was rejected.",
};
export function macHelperError(result) {
  const code = Object.hasOwn(messages, result?.code)
    ? result.code
    : "MAC_NATIVE_FAILED";
  let message = messages[code];
  if (
    [
      "decode",
      "permissions",
      "window-query",
      "focus",
      "input",
      "chooser",
    ].includes(result?.stage)
  )
    message += ` Helper stage: ${result.stage}.`;
  return nativeError(code, message);
}
