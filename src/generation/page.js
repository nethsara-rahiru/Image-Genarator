// Fixed browser-side program. No model-provided code, selectors or URLs.
export async function generationPage(request) {
  const current = new URL(location.href);
  const origin = request.origin || "https://gemini.google.com";
  if (current.origin !== origin) return { kind: "needs_login" };
  const visible = (e) =>
    !!e &&
    !!e.getClientRects().length &&
    getComputedStyle(e).visibility !== "hidden";
  const all = (selector) =>
    [...document.querySelectorAll(selector)].filter(visible);
  const label = (e) =>
    (
      e.getAttribute("aria-label") ||
      e.getAttribute("title") ||
      e.getAttribute("data-tooltip") ||
      e.innerText ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ");
  const controls = all("button,[role=button],a");
  const account = controls.find((e) =>
    /^Google Account\s*:/i.test(e.getAttribute("aria-label") || ""),
  );
  if (!account || controls.some((e) => /^sign in$/i.test(label(e))))
    return { kind: "needs_login" };
  const keyBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(account.getAttribute("aria-label")),
  );
  const accountKey = [...new Uint8Array(keyBytes)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  if (
    location.origin !== origin ||
    (request.accountKey && request.accountKey !== accountKey)
  )
    return { kind: "account_changed" };
  const state = (globalThis[Symbol.for("local-gemini-generation")] ||= {
    nodes: new WeakMap(),
    next: 0,
  });
  const id = (e) => {
    if (!state.nodes.has(e)) state.nodes.set(e, "e" + ++state.next);
    return state.nodes.get(e);
  };
  const responses = all(
    'model-response,[data-message-author-role="model"],.model-response',
  ).filter((e, i, items) => !items.some((p, j) => i !== j && p.contains(e)));
  const ids = responses.map(id);
  const imageKey = async (image) => {
    const url = new URL(image.currentSrc || image.src, location.href);
    if (/(^|\.)googleusercontent\.com$/.test(url.hostname))
      url.pathname = url.pathname.replace(/=[^/]*$/, "");
    const data = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(url.href.slice(0, 4096)),
    );
    return [...new Uint8Array(data)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  };
  const imageKeys = await Promise.all(
    responses.flatMap((r) => [...r.querySelectorAll("img")]).map(imageKey),
  );
  const match = current.pathname.match(/^\/app\/([A-Za-z0-9_-]{4,160})\/?$/);
  const chatId = match?.[1] || null;
  const base = {
    kind: "ready",
    accountKey,
    chatId,
    chatUrl: chatId ? origin + "/app/" + chatId : null,
    responseIds: ids,
    imageKeys,
  };
  const editors = all(
    '[contenteditable="true"][role="textbox"],.ql-editor[contenteditable="true"],textarea',
  ).filter(
    (e, i, a) => a.indexOf(e) === i && !responses.some((r) => r.contains(e)),
  );
  const editor = editors.length === 1 ? editors[0] : null;
  const send = controls.filter(
    (e) => /^(send|send message|submit prompt)$/i.test(label(e)) && !e.disabled,
  );
  if (request.operation === "new_chat") {
    const buttons = controls.filter((e) =>
      /^(new chat|start new chat)$/i.test(label(e)),
    );
    if (buttons.length !== 1) return { ok: false };
    if (
      buttons[0].tagName === "A" &&
      new URL(buttons[0].href, location.href).origin !== origin
    )
      return { ok: false };
    buttons[0].click();
    return { ok: true };
  }
  if (request.operation === "fill_prompt") {
    if (!editor || editor.readOnly || editor.disabled) return { ok: false };
    editor.focus();
    if (editor.tagName === "TEXTAREA")
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ).set.call(editor, request.prompt);
    else editor.textContent = request.prompt;
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: request.prompt,
      }),
    );
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (request.operation === "send") {
    if (
      !editor ||
      (editor.value ?? editor.textContent) !== request.prompt ||
      send.length !== 1 ||
      ids.join(",") !== (request.baseline || []).join(",")
    )
      return { ok: false };
    send[0].click();
    return { ok: true };
  }
  const fresh = responses.filter(
    (e) => !(request.baseline || []).includes(id(e)),
  );
  const response = fresh.at(-1);
  const busy =
    controls.some((e) =>
      /^(stop|stop response|stop generating|stop generating response)$/i.test(
        label(e),
      ),
    ) ||
    (!!response &&
      (response.getAttribute("aria-busy") === "true" ||
        response.getAttribute("data-is-streaming") === "true"));
  const limited =
    /usage limit|rate limit|too many requests|try again later|unusual activity|account.{0,40}(?:disabled|suspended|locked)/i.test(
      all('[role="alert"],[role="dialog"],.error-message,[data-error]')
        .filter(
          (e) => !responses.some((r) => r.contains(e)) && !editor?.contains(e),
        )
        .map((e) => e.textContent)
        .join(" "),
    );
  if (limited) return { ...base, kind: "restricted" };
  let selected;
  if (response) {
    let images = [...response.querySelectorAll("img")]
      .filter(
        (e) =>
          visible(e) &&
          e.complete &&
          e.naturalWidth >= 64 &&
          e.naturalHeight >= 64 &&
          !/avatar|profile/i.test(e.alt || ""),
      )
      .filter((e) => {
        try {
          const src = new URL(e.currentSrc || e.src, location.href);
          return (
            src.origin === origin ||
            (src.protocol === "blob:" && src.origin === origin) ||
            (src.protocol === "https:" &&
              /(^|\.)googleusercontent\.com$/.test(src.hostname))
          );
        } catch {
          return false;
        }
      });
    const allowedImages = [];
    for (const image of images)
      if (!(request.baselineImages || []).includes(await imageKey(image)))
        allowedImages.push(image);
    images = allowedImages;
    const image = images[0];
    if (image) {
      let container = image.parentElement,
        download;
      while (container && response.contains(container)) {
        const siblings = images.filter((e) => container.contains(e));
        const buttons = [
          ...container.querySelectorAll('button,[role="button"]'),
        ].filter((e) => !e.disabled && /download/i.test(label(e)));
        if (buttons.length === siblings.length && buttons.length > 0) {
          download = buttons[siblings.indexOf(image)];
          break;
        }
        if (container === response) break;
        container = container.parentElement;
      }
      selected = {
        responseId: id(response),
        imageId: id(image),
        buttonId: download ? id(download) : null,
      };
    }
  }
  if (request.operation === "hover_image") {
    if (!selected || selected.imageId !== request.selection?.imageId)
      return { ok: false };
    const image = [...response.querySelectorAll("img")].find(
      (e) => id(e) === selected.imageId,
    );
    image.scrollIntoView({ block: "center", inline: "center" });
    const rect = image.getBoundingClientRect();
    return {
      ok: true,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  }
  if (request.operation === "download") {
    if (
      busy ||
      !selected ||
      !selected.buttonId ||
      selected.responseId !== request.selection?.responseId ||
      selected.imageId !== request.selection?.imageId ||
      selected.buttonId !== request.selection?.buttonId
    )
      return { ok: false };
    const button = [
      ...response.querySelectorAll('button,[role="button"]'),
    ].find((e) => id(e) === selected.buttonId);
    button.click();
    return { ok: true };
  }
  const pendingImage =
    !!response &&
    [...response.querySelectorAll("img")].some(
      (e) =>
        !/avatar|profile/i.test(e.alt || "") &&
        (e.naturalWidth === 0 || e.naturalWidth >= 64),
    );
  const complete =
    !!response &&
    [...response.querySelectorAll('button,[role="button"]')].some(
      (e) =>
        visible(e) &&
        /^(good response|bad response|copy response|copy)$/i.test(label(e)),
    );
  return {
    ...base,
    busy,
    selection: selected || null,
    hasResponse: !!response,
    textOnly: complete && !busy && !pendingImage,
    canSend: send.length === 1,
    editorReady: !!editor,
  };
}
