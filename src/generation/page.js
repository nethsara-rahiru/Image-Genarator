// Fixed browser-side program. No model-provided code, selectors or URLs.
export async function generationPage(request) {
  const current = new URL(location.href);
  const origin = request.origin || "https://gemini.google.com";
  if (current.origin !== origin) return { kind: "needs_login" };
  if (document.readyState !== "complete") return { kind: "loading" };
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
  if (controls.some((e) => /^sign in$/i.test(label(e))))
    return { kind: "needs_login" };
  if (!account) return { kind: "loading" };
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
  const composer =
    editor?.closest(
      "input-area-v2,input-area,form,.input-area-container,.input-container",
    ) || editor?.parentElement;
  const attachmentsReady = (names) => {
    if (!names?.length) return true;
    if (
      !composer ||
      [
        ...composer.querySelectorAll(
          '[role="progressbar"],[aria-busy="true"],mat-progress-spinner,mat-progress-bar,.uploading,[data-upload-state="uploading"]',
        ),
      ].some(visible)
    )
      return false;
    const text = `${composer.innerText} ${[
      ...composer.querySelectorAll("[aria-label],img[alt],[title]"),
    ]
      .filter(visible)
      .map(
        (node) =>
          `${node.getAttribute("aria-label") || ""} ${node.getAttribute("alt") || ""} ${node.getAttribute("title") || ""}`,
      )
      .join(" ")}`;
    return names.every((name) => text.includes(name));
  };
  if (request.operation === "prepare_attachments") {
    let inputs = [...document.querySelectorAll('input[type="file"]')].filter(
      (input) =>
        !input.disabled &&
        !responses.some((response) => response.contains(input)) &&
        (!input.accept || /image|\.png|\.jpe?g|\.webp/i.test(input.accept)),
    );
    const local = inputs.filter((input) => composer?.contains(input));
    if (local.length) inputs = local;
    const explicitImages = inputs.filter((input) =>
      /image|\.png|\.jpe?g|\.webp/i.test(input.accept),
    );
    if (explicitImages.length) inputs = explicitImages;
    if (inputs.length === 1) {
      for (const marked of document.querySelectorAll(
        "[data-local-reference-input]",
      ))
        marked.removeAttribute("data-local-reference-input");
      inputs[0].setAttribute("data-local-reference-input", "true");
      return { ok: true };
    }
    const uploadControls = all(
      'button,[role="button"],[role="menuitem"],label',
    ).filter(
      (node) =>
        !node.disabled &&
        node.getAttribute("aria-disabled") !== "true" &&
        !responses.some((response) => response.contains(node)),
    );
    if (inputs.length !== 1) {
      // Portalled menu items are often outside the composer. Prefer an open
      // upload menu over its opener, so polling cannot toggle it shut.
      let upload = uploadControls.filter((node) =>
        /^(upload files?|upload from (?:computer|device)|from (?:computer|device))$/i.test(
          label(node),
        ),
      );
      if (!upload.length) {
        upload = uploadControls.filter((node) =>
          /^(open (?:upload file|file upload|upload) menu|add files?(?: and tools)?|add photos?(?: and files)?|upload photos?(?: and files)?)$/i.test(
            label(node),
          ),
        );
        const localControls = upload.filter((node) => composer?.contains(node));
        if (localControls.length) upload = localControls;
        if (!upload.length)
          upload = uploadControls.filter(
            (node) =>
              composer?.contains(node) &&
              /^(\+|add|attach files?)$/i.test(label(node)),
          );
        upload = upload.filter(
          (node) => node.getAttribute("aria-expanded") !== "true",
        );
      }
      if (upload.length === 1 && !state.uploadClicked?.has(upload[0])) {
        state.uploadClicked ||= new WeakSet();
        state.uploadClicked.add(upload[0]);
        upload[0].click();
        return {
          ok: false,
          reason: "upload_menu_opened",
          candidates: inputs.length,
        };
      }
    }
    return {
      ok: false,
      reason: inputs.length > 1 ? "ambiguous_inputs" : "input_not_found",
      candidates: inputs.length,
    };
  }
  if (request.operation === "attachments_ready")
    return { ok: attachmentsReady(request.referenceNames) };
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
      ids.join(",") !== (request.baseline || []).join(",") ||
      !attachmentsReady(request.referenceNames)
    )
      return { ok: false };
    send[0].click();
    return { ok: true };
  }
  let fresh = responses.filter(
    (e) => !(request.baseline || []).includes(id(e)),
  );
  if (request.recoverImageKey) {
    const matching = [];
    for (const r of responses)
      for (const image of r.querySelectorAll("img"))
        if ((await imageKey(image)) === request.recoverImageKey)
          matching.push(r);
    fresh = [...new Set(matching)];
    if (fresh.length !== 1) return { ...base, kind: "recovery_unverified" };
  } else if (request.recoverPrompt) {
    const normalize = (text) =>
      text
        .replace(/^You said\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
    const turns = all('user-query,[data-message-author-role="user"]').filter(
      (e) => !responses.some((r) => r.contains(e)),
    );
    const matches = turns.filter(
      (e) =>
        normalize((e.querySelector(".query-text") || e).textContent) ===
        normalize(request.recoverPrompt),
    );
    if (matches.length !== 1) return { ...base, kind: "recovery_unverified" };
    const user = matches[0];
    const following = (e) =>
      !!(user.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
    const nextUser = turns.find((e) => e !== user && following(e));
    fresh = responses.filter(
      (r) =>
        following(r) &&
        (!nextUser ||
          !!(
            r.compareDocumentPosition(nextUser) &
            Node.DOCUMENT_POSITION_FOLLOWING
          )),
    );
    if (fresh.length !== 1) return { ...base, kind: "recovery_unverified" };
  }
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
    const image = request.recoverImageKey
      ? (
          await Promise.all(
            images.map(async (e) => ({ e, key: await imageKey(e) })),
          )
        ).find((entry) => entry.key === request.recoverImageKey)?.e
      : images[0];
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
        imageKey: await imageKey(image),
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
    image.scrollIntoView({
      behavior: "instant",
      block: "center",
      inline: "center",
    });
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
    button.scrollIntoView({
      behavior: "instant",
      block: "nearest",
      inline: "nearest",
    });
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2,
      y = rect.y + rect.height / 2;
    if (!visible(button) || !button.contains(document.elementFromPoint(x, y)))
      return { ok: false };
    return { ok: true, x, y };
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
