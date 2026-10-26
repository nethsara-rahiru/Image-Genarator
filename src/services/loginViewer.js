import { WebSocketServer } from "ws";
const keys = [
  "Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Control+A",
];
export function attachViewer(server, sessionMiddleware, accounts, config) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, config.PUBLIC_ORIGIN);
    } catch {
      socket.destroy();
      return;
    }
    if (
      url.pathname !== "/viewer" ||
      req.headers.origin !== config.PUBLIC_ORIGIN ||
      !/^[a-f\d]{24}$/i.test(url.searchParams.get("account") || "")
    ) {
      socket.destroy();
      return;
    }
    sessionMiddleware(req, {}, () => {
      if (
        !req.session?.adminId ||
        url.searchParams.get("csrf") !== req.session.csrf
      ) {
        socket.destroy();
        return;
      }
      const session = accounts.logins.get(url.searchParams.get("account"));
      if (!session) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        let busy = false,
          inputs = 0,
          queued = 0;
        let inputChain = Promise.resolve();
        const active = () =>
          accounts.logins.get(session.accountId) === session &&
          (!session.expiresAt || session.expiresAt > new Date());
        const status = () => {
          if (ws.readyState === 1)
            ws.send(
              JSON.stringify({
                type: "status",
                message: "Waiting for the Google page to finish loading…",
              }),
            );
        };
        const budget = setInterval(() => {
          inputs = 0;
        }, 1000);
        const timer = setInterval(async () => {
          if (busy || ws.readyState !== 1 || ws.bufferedAmount > 500000) return;
          if (!active()) {
            ws.close(4004, "Login session ended");
            return;
          }
          busy = true;
          try {
            // Authentication failure is terminal; a screenshot/navigation failure is not.
            try {
              await new Promise((resolve, reject) =>
                req.session.reload((e) => (e ? reject(e) : resolve())),
              );
              if (
                !req.session.adminId ||
                new Date(req.session.cookie.expires) <= new Date()
              )
                throw new Error("expired");
            } catch {
              ws.close(4001, "Administrator session expired");
              return;
            }
            try {
              const img = await session.page.screenshot({
                type: "jpeg",
                quality: 65,
                animations: "disabled",
                timeout: 5000,
              });
              if (ws.readyState === 1 && active()) ws.send(img);
            } catch {
              status();
            }
          } finally {
            busy = false;
          }
        }, 500);
        ws.on("message", (bytes) => {
          if (++inputs > 80 || queued >= 100 || !active()) return;
          let v;
          try {
            v = JSON.parse(bytes);
          } catch {
            ws.close(1008, "Invalid viewer input");
            return;
          }
          queued++;
          inputChain = inputChain
            .then(async () => {
              if (ws.readyState !== 1 || !active()) return;
              try {
                const page = session.page;
                if (
                  v.type === "click" &&
                  Number.isFinite(v.x) &&
                  Number.isFinite(v.y) &&
                  v.x >= 0 &&
                  v.y >= 0 &&
                  v.x < 1280 &&
                  v.y < 800
                )
                  await page.mouse.click(v.x, v.y, { timeout: 5000 });
                if (
                  v.type === "text" &&
                  typeof v.text === "string" &&
                  v.text.length <= 1000
                )
                  await page.keyboard.insertText(v.text);
                if (v.type === "key" && keys.includes(v.key))
                  await page.keyboard.press(v.key);
                if (v.type === "scroll" && Number.isFinite(v.dy))
                  await page.mouse.wheel(
                    0,
                    Math.max(-1000, Math.min(1000, v.dy)),
                  );
              } catch {
                status();
              }
            })
            .finally(() => {
              queued--;
            });
        });
        ws.on("error", () => {});
        ws.on("close", () => {
          clearInterval(timer);
          clearInterval(budget);
        });
      });
    });
  });
  return wss;
}
