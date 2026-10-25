import { WebSocketServer } from "ws";
export function attachViewer(server, sessionMiddleware, accounts, config) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, config.PUBLIC_ORIGIN);
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
        let busy = false;
        let pending = false;
        let inputs = 0;
        const budget = setInterval(() => {
          inputs = 0;
        }, 1000);
        const timer = setInterval(async () => {
          if (busy || ws.readyState !== 1 || ws.bufferedAmount > 500000) return;
          if (!accounts.logins.has(session.accountId)) {
            ws.close();
            return;
          }
          busy = true;
          try {
            await new Promise((resolve, reject) =>
              req.session.reload((e) => (e ? reject(e) : resolve())),
            );
            if (
              !req.session.adminId ||
              new Date(req.session.cookie.expires) <= new Date()
            ) {
              ws.close();
              return;
            }
            const img = await session.page.screenshot({
              type: "jpeg",
              quality: 65,
              timeout: 3000,
            });
            ws.send(img);
          } catch {
            ws.close();
          } finally {
            busy = false;
          }
        }, 500);
        ws.on("message", async (bytes) => {
          if (pending || ++inputs > 40) return;
          pending = true;
          try {
            const v = JSON.parse(bytes);
            if (
              v.type === "click" &&
              Number.isFinite(v.x) &&
              Number.isFinite(v.y) &&
              v.x >= 0 &&
              v.y >= 0 &&
              v.x < 1280 &&
              v.y < 800
            )
              await session.page.mouse.click(v.x, v.y);
            if (
              v.type === "text" &&
              typeof v.text === "string" &&
              v.text.length <= 1000
            )
              await session.page.keyboard.insertText(v.text);
            if (
              v.type === "key" &&
              [
                "Enter",
                "Tab",
                "Backspace",
                "Escape",
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Control+A",
              ].includes(v.key)
            )
              await session.page.keyboard.press(v.key);
            if (v.type === "scroll" && Number.isFinite(v.dy))
              await session.page.mouse.wheel(
                0,
                Math.max(-1000, Math.min(1000, v.dy)),
              );
          } catch {
            ws.close();
          } finally {
            pending = false;
          }
        });
        ws.on("close", () => {
          clearInterval(timer);
          clearInterval(budget);
        });
      });
    });
  });
  return wss;
}
