import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import {
  run,
  findCommand,
  nativeError,
  terminate,
  jpegDimensions,
} from "./common.js";
export class LinuxDriver {
  constructor(data) {
    this.data = data;
    this.children = [];
    this.env = null;
  }
  async prepare() {
    for (const name of [
      "Xvfb",
      "xauth",
      "xdotool",
      "openbox",
      "import",
      "xprop",
      "dbus-daemon",
    ])
      if (!(await findCommand(name)))
        throw nativeError(
          "LINUX_PACKAGES_MISSING",
          "Linux desktop packages are missing. Run npm run setup-host (or scripts/install-ubuntu.sh) once, then retry.",
        );
    await fs.mkdir(this.data, { recursive: true, mode: 0o700 });
    let display;
    for (let n = 90; n < 290; n++) {
      try {
        await fs.access(`/tmp/.X11-unix/X${n}`);
      } catch {
        try {
          await fs.access(`/tmp/.X${n}-lock`);
        } catch {
          display = `:${n}`;
          break;
        }
      }
    }
    if (!display)
      throw nativeError(
        "DISPLAY_UNAVAILABLE",
        "No private X display is available.",
      );
    const authority = path.join(this.data, "Xauthority");
    await fs.writeFile(authority, "", { mode: 0o600 });
    await run("xauth", ["-f", authority], {
      input: `add ${display} . ${randomBytes(16).toString("hex")}\n`,
    });
    const desktopEnv = {
      ...process.env,
      DISPLAY: display,
      XAUTHORITY: authority,
      GSETTINGS_BACKEND: "memory",
      WAYLAND_DISPLAY: "",
      XDG_CURRENT_DESKTOP: "OPENBOX",
      XDG_SESSION_TYPE: "x11",
      DESKTOP_SESSION: "openbox",
    };
    const bus = spawn(
      "dbus-daemon",
      ["--session", "--nofork", "--print-address=1"],
      { env: desktopEnv, stdio: ["ignore", "pipe", "ignore"] },
    );
    this.children.push(bus);
    bus.on("error", () => {});
    const address = await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(
        () =>
          reject(
            nativeError(
              "DISPLAY_UNAVAILABLE",
              "A private D-Bus session could not start.",
            ),
          ),
        3000,
      );
      bus.stdout.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("\n")) {
          clearTimeout(timer);
          resolve(text.split("\n")[0]);
        }
      });
      bus.once("error", () => {
        clearTimeout(timer);
        reject(
          nativeError(
            "LINUX_PACKAGES_MISSING",
            "Install dbus-daemon for the native desktop.",
          ),
        );
      });
    });
    this.env = { ...desktopEnv, DBUS_SESSION_BUS_ADDRESS: address };
    const x = spawn(
      "Xvfb",
      [
        display,
        "-screen",
        "0",
        "1280x900x24",
        "-nolisten",
        "tcp",
        "-auth",
        authority,
      ],
      { env: this.env, stdio: "ignore" },
    );
    this.children.push(x);
    x.on("error", () => {});
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (x.exitCode !== null) break;
      try {
        await run("xdotool", ["getdisplaygeometry"], {
          env: this.env,
          timeout: 1000,
        });
        ready = true;
        break;
      } catch {
        await pause(50);
      }
    }
    if (!ready)
      throw nativeError(
        "DISPLAY_UNAVAILABLE",
        "The private X display could not start. Run npm run doctor.",
      );
    const wm = spawn("openbox", ["--sm-disable"], {
      env: this.env,
      stdio: "ignore",
    });
    wm.on("error", () => {});
    this.children.push(wm);
    await pause(150);
    return this.env;
  }
  async capture() {
    const image = await run(
      "import",
      ["-window", "root", "-quality", "65", "jpeg:-"],
      { env: this.env, timeout: 5000 },
    );
    return { image, ...jpegDimensions(image) };
  }
  async command(d) {
    const call = (args) => run("xdotool", args, { env: this.env });
    if (d.type === "close") {
      await call(["key", "--clearmodifiers", "alt+F4"]);
    } else if (d.type === "click")
      await call([
        "mousemove",
        "--sync",
        String(Math.round(d.x)),
        String(Math.round(d.y)),
        "click",
        ...(d.double ? ["--repeat", "2", "--delay", "80"] : []),
        d.button === "right" ? "3" : d.button === "middle" ? "2" : "1",
      ]);
    else if (d.type === "scroll") {
      if (d.y)
        await call([
          "click",
          "--repeat",
          String(Math.min(8, Math.max(1, Math.round(Math.abs(d.y) / 120)))),
          "--delay",
          "30",
          d.y > 0 ? "5" : "4",
        ]);
      if (d.x) await call(["click", d.x > 0 ? "7" : "6"]);
    } else if (d.type === "text")
      await run("xdotool", ["type", "--clearmodifiers", "--file", "-"], {
        env: this.env,
        input: d.text,
      });
    else if (d.type === "key") {
      const key = d.key
        .replaceAll("Control", "ctrl")
        .replaceAll("Meta", "super")
        .replaceAll("Alt", "alt")
        .replaceAll("Shift", "shift")
        .replaceAll("ArrowLeft", "Left")
        .replaceAll("ArrowRight", "Right")
        .replaceAll("ArrowUp", "Up")
        .replaceAll("ArrowDown", "Down")
        .replaceAll("Enter", "Return")
        .replaceAll("Space", "space")
        .replaceAll("PageUp", "Prior")
        .replaceAll("PageDown", "Next");
      const parts = key.split("+");
      if (/^[a-z]$/i.test(parts.at(-1)))
        parts[parts.length - 1] = parts.at(-1).toLowerCase();
      await call(["key", "--clearmodifiers", parts.join("+")]);
    }
  }
  async fileDialog() {
    const id = (await run("xdotool", ["getactivewindow"], { env: this.env }))
      .toString()
      .trim();
    if (!/^\d+$/.test(id)) return false;
    const type = (
      await run("xprop", ["-id", id, "_NET_WM_WINDOW_TYPE"], { env: this.env })
    ).toString();
    return type.includes("_NET_WM_WINDOW_TYPE_DIALOG");
  }
  async upload(file) {
    if (!(await this.fileDialog()))
      throw nativeError(
        "FILE_DIALOG_REQUIRED",
        "Click a website file picker before uploading.",
      );
    await this.command({ type: "key", key: "Control+L" });
    await pause(100); // Let the native GTK location entry acquire focus.
    await this.command({ type: "text", text: file });
    await this.command({ type: "key", key: "Alt+o" });
    for (let i = 0; i < 10; i++) {
      await pause(50);
      if (!(await this.fileDialog())) return;
    }
    // Some GTK choosers resolve the location first and require a second Open.
    if (await this.fileDialog())
      await this.command({ type: "key", key: "Enter" });
    for (let i = 0; i < 30; i++) {
      await pause(50);
      if (!(await this.fileDialog())) return;
    }
    throw nativeError(
      "FILE_DIALOG_REQUIRED",
      "The native chooser did not accept the file. Inspect the chooser and select Open manually.",
    );
  }
  async close() {
    for (const child of this.children.reverse()) await terminate(child);
    this.children = [];
    this.env = null;
  }
}
