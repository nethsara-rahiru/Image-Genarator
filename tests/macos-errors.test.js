import test from "node:test";
import assert from "node:assert/strict";
import { macHelperError } from "../src/native/macosErrors.js";
test("macOS native failures distinguish permissions from missing windows and bridge errors", () => {
  for (const code of [
    "WINDOW_NOT_READY",
    "FOCUS_DENIED",
    "MAC_AUTOMATION_REQUIRED",
    "MAC_ACCESSIBILITY_REQUIRED",
    "MAC_SCREEN_RECORDING_REQUIRED",
    "MAC_CAPTURE_FAILED",
    "MAC_WINDOW_QUERY_FAILED",
    "FILE_DIALOG_REQUIRED",
    "MAC_NATIVE_FAILED",
  ]) {
    const error = macHelperError({
      code,
      stage: "window-query",
      message: "password=do-not-echo",
      raw: "/private/profile?token=hidden",
    });
    assert.equal(error.code, code);
    assert.match(error.message, /Helper stage: window-query/);
    assert.doesNotMatch(
      error.message,
      /do-not-echo|token=hidden|private\/profile/,
    );
  }
  assert.equal(
    macHelperError({ code: "UNTRUSTED_CODE", stage: "password=secret" }).code,
    "MAC_NATIVE_FAILED",
  );
  assert.doesNotMatch(
    macHelperError({ code: "UNTRUSTED_CODE", stage: "password=secret" })
      .message,
    /password=secret/,
  );
});
import fs from "node:fs/promises";
import vm from "node:vm";
const source = await fs.readFile(
  new URL("../src/native/macos.js", import.meta.url),
  "utf8",
);
function simulate(
  request,
  {
    list = [
      {
        kCGWindowOwnerPID: 123,
        kCGWindowLayer: 0,
        kCGWindowNumber: 17,
        kCGWindowBounds: { X: 0, Y: 0, Width: 1280, Height: 800 },
      },
    ],
    unwrap = (value) => value,
    cast = (value) => value,
    application,
    screen = true,
    accessibility = true,
  } = {},
) {
  const system =
    application ||
    (() => ({
      processes: { whose: () => [{ unixId: () => 123 }] },
      keystroke() {},
      keyCode() {},
    }));
  const context = vm.createContext({
    ObjC: { import() {}, deepUnwrap: unwrap, castRefToObject: cast },
    Application: system,
    delay() {},
    $: {
      NSFileHandle: {
        fileHandleWithStandardInput: { readDataToEndOfFile: null },
      },
      NSString: {
        alloc: {
          initWithDataEncoding: () => ({ js: JSON.stringify(request) }),
        },
      },
      NSUTF8StringEncoding: 4,
      CGPreflightScreenCaptureAccess: () => screen,
      AXIsProcessTrusted: () => accessibility,
      CGWindowListCopyWindowInfo: () => list,
    },
  });
  vm.runInContext(source, context);
  return JSON.parse(vm.runInContext("run()", context));
}
test("JXA window metadata handles CF bridging and distinguishes no visible window", () => {
  const opaque = { opaque: true };
  const list = [
    {
      kCGWindowOwnerPID: 123,
      kCGWindowLayer: 0,
      kCGWindowNumber: 17,
      kCGWindowBounds: { X: 0, Y: 0, Width: 1280, Height: 800 },
    },
  ];
  const captured = simulate(
    { type: "capture", pid: 123 },
    { list: opaque, unwrap: (value) => value, cast: () => list },
  );
  assert.equal(captured.ok, true);
  assert.equal(captured.result.windowId, 17);
  assert.equal(
    simulate({ type: "capture", pid: 999 }).code,
    "WINDOW_NOT_READY",
  );
  const broken = simulate(
    { type: "diagnostics", pid: 123 },
    {
      unwrap: () => {
        throw new Error("private token=do-not-echo");
      },
      cast: () => {
        throw new Error("bridge error");
      },
    },
  );
  assert.equal(broken.code, "MAC_WINDOW_QUERY_FAILED");
  assert.doesNotMatch(JSON.stringify(broken), /do-not-echo/);
});
test("JXA diagnoses denied Automation and Accessibility without labelling every error a permission problem", () => {
  const automation = simulate(
    { type: "key", pid: 123, key: "Meta+l" },
    {
      application: () => {
        const error = new Error("Private raw Apple event");
        error.number = -1743;
        throw error;
      },
    },
  );
  assert.equal(automation.code, "MAC_AUTOMATION_REQUIRED");
  assert.equal(automation.stage, "focus");
  const accessibility = simulate(
    { type: "text", pid: 123, text: "do-not-echo" },
    {
      application: () => ({
        processes: { whose: () => [{ unixId: () => 123 }] },
        keystroke() {
          const error = new Error(
            "not allowed assistive access for private text",
          );
          error.number = -1719;
          throw error;
        },
      }),
    },
  );
  assert.equal(accessibility.code, "MAC_ACCESSIBILITY_REQUIRED");
  assert.doesNotMatch(
    JSON.stringify(accessibility),
    /do-not-echo|private text/,
  );
  const bridge = simulate(
    { type: "key", pid: 123, key: "Meta+l" },
    {
      application: () => {
        const error = new Error("Invalid process index");
        error.number = -1719;
        throw error;
      },
    },
  );
  assert.equal(bridge.code, "MAC_NATIVE_FAILED");
});
test("JXA permission diagnostics are read-only and do not ask System Events to automate anything", () => {
  const result = simulate(
    { type: "diagnostics", pid: 123 },
    {
      screen: false,
      accessibility: false,
      application: () => {
        throw new Error("System Events must not be called");
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.permissions.screenRecording, false);
  assert.equal(result.result.permissions.accessibility, false);
  assert.equal(result.result.visibleManagedWindows, 1);
});
