// JXA, executed by /usr/bin/osascript, not imported by Node or served to clients.
ObjC.import("Foundation");
ObjC.import("CoreGraphics");
function run() {
  try {
    const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    const request = JSON.parse(
      $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js,
    );
    const all = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0));
    const window = all.find(
      (w) =>
        w.kCGWindowOwnerPID === request.pid &&
        w.kCGWindowLayer === 0 &&
        w.kCGWindowBounds.Width > 50 &&
        w.kCGWindowBounds.Height > 50,
    );
    if (!window) throw new Error("WINDOW_NOT_READY");
    const rect = window.kCGWindowBounds;
    if (request.type === "capture")
      return JSON.stringify({
        ok: true,
        result: { windowId: window.kCGWindowNumber, rect },
      });
    const system = Application("System Events");
    const process = system.processes.whose({ unixId: request.pid })[0];
    process.frontmost = true;
    delay(0.05);
    const front = system.processes.whose({ frontmost: true })[0];
    if (front.unixId() !== request.pid) throw new Error("FOCUS_DENIED");
    const keyMap = {
      Enter: 36,
      Tab: 48,
      Space: 49,
      Backspace: 51,
      Escape: 53,
      Delete: 117,
      ArrowLeft: 123,
      ArrowRight: 124,
      ArrowDown: 125,
      ArrowUp: 126,
      Home: 115,
      End: 119,
      PageUp: 116,
      PageDown: 121,
      F5: 96,
    };
    if (request.type === "upload") {
      const windows = process.windows();
      const hasDialog = windows.some((w) => {
        try {
          return w.subrole() === "AXDialog" || w.sheets().length > 0;
        } catch {
          return false;
        }
      });
      if (!hasDialog) throw new Error("FILE_DIALOG_REQUIRED");
      system.keystroke("g", { using: ["command down", "shift down"] });
      delay(0.25);
      system.keystroke(request.file);
      system.keyCode(36);
      delay(0.3);
      system.keyCode(36);
    } else if (request.type === "text") system.keystroke(request.text);
    else if (request.type === "key") {
      const parts = request.key.split("+");
      let key = parts.pop();
      if (/^[a-z]$/i.test(key)) key = key.toLowerCase();
      const using = parts.map(
        (p) =>
          ({
            Control: "control down",
            Meta: "command down",
            Alt: "option down",
            Shift: "shift down",
          })[p],
      );
      if (keyMap[key] !== undefined) system.keyCode(keyMap[key], { using });
      else system.keystroke(key, { using });
    } else if (request.type === "click") {
      const x = rect.X + (request.x * rect.Width) / request.frameWidth,
        y = rect.Y + (request.y * rect.Height) / request.frameHeight;
      const right = request.button === "right",
        button = right ? 1 : 0;
      for (let i = 0; i < (request.double ? 2 : 1); i++) {
        const down = $.CGEventCreateMouseEvent(
            null,
            right ? 3 : 1,
            { x, y },
            button,
          ),
          up = $.CGEventCreateMouseEvent(null, right ? 4 : 2, { x, y }, button);
        $.CGEventPost(0, down);
        $.CGEventPost(0, up);
      }
    } else if (request.type === "scroll") {
      const event = $.CGEventCreate(null);
      $.CGEventSetType(event, 22);
      $.CGEventSetIntegerValueField(event, 11, -Math.round(request.y / 40));
      $.CGEventSetIntegerValueField(event, 12, Math.round(request.x / 40));
      $.CGEventPost(0, event);
    } else if (request.type === "close")
      system.keystroke("q", { using: ["command down"] });
    else throw new Error("INPUT_DENIED");
    return JSON.stringify({ ok: true, result: {} });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      code:
        error.message === "FILE_DIALOG_REQUIRED"
          ? "FILE_DIALOG_REQUIRED"
          : "DESKTOP_PERMISSION_REQUIRED",
    });
  }
}
