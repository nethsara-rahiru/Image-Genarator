export class BrowserStartupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserStartupError";
    this.code = code;
  }
}
export function browserStartupError(error) {
  if (error instanceof BrowserStartupError) return error;
  const text = String(error?.message || error);
  const rules = [
    [
      /non-root|Running as root/i,
      "BROWSER_ROOT",
      "Chromium must run as your non-root service user (for example dev). Do not start the application with sudo.",
    ],
    [
      /Executable doesn't exist|browser executable.*not found/i,
      "BROWSER_MISSING",
      "Chromium is not installed for this service user. Run npx playwright install --with-deps chromium as that user, then restart the app.",
    ],
    [
      /missing dependencies|error while loading shared libraries|cannot open shared object file/i,
      "BROWSER_DEPENDENCIES",
      "Chromium system libraries are missing. Run npx playwright install --with-deps chromium as the service user (sudo may be requested for system packages).",
    ],
    [
      /ProcessSingleton|SingletonLock|profile.*in use|already in use/i,
      "BROWSER_PROFILE_BUSY",
      "The browser profile is locked by another Chromium process. Stop the other application instance gracefully, then retry. Do not delete a live profile lock.",
    ],
    [
      /No usable sandbox|Failed to move to new namespace|Operation not permitted|user namespace|apparmor/i,
      "BROWSER_SANDBOX",
      "Chromium sandbox startup was blocked. Run npm run doctor in the VPS terminal to inspect sandbox/AppArmor restrictions. Keep sandboxing enabled.",
    ],
    [
      /EACCES|EPERM|Permission denied/i,
      "BROWSER_PERMISSIONS",
      "The service user cannot access the browser installation or DATA_DIR. Check ownership and permissions; run npm run doctor.",
    ],
    [
      /Timeout.*exceeded|timed out/i,
      "BROWSER_START_TIMEOUT",
      "Chromium startup timed out. Check VPS memory and process limits, then run npm run doctor.",
    ],
  ];
  for (const [pattern, code, message] of rules)
    if (pattern.test(text)) return new BrowserStartupError(code, message);
  return new BrowserStartupError(
    "BROWSER_START_FAILED",
    "Chromium could not start. Run npm run doctor in the VPS terminal for launch diagnostics.",
  );
}
