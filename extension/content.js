(() => {
  let run,
    aborted = false;
  const visible = (e) =>
    Boolean(
      e &&
      e.getClientRects().length &&
      getComputedStyle(e).visibility !== "hidden",
    );
  const label = (e) =>
    e.getAttribute("aria-label") || e.getAttribute("title") || "";
  const controls = () => [
    ...document.querySelectorAll(
      'button,input[type="file"],[role="textbox"],textarea',
    ),
  ];
  const composerSelectors = [
    '[contenteditable="true"][role="textbox"]',
    'rich-textarea [contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    'textarea[aria-label*="prompt" i]',
  ];
  function ensure(id) {
    if (!run || run.id !== id || aborted)
      throw Object.assign(new Error("Run stopped or replaced"), {
        code: "LOCAL_DISCONNECTED",
      });
    if (location.origin !== "https://gemini.google.com")
      throw new Error("Blocked page origin");
  }
  function signedIn() {
    return (
      location.origin === "https://gemini.google.com" &&
      composerSelectors.some((s) =>
        [...document.querySelectorAll(s)].some(visible),
      ) &&
      !controls().some(
        (e) =>
          visible(e) && /^sign in$/i.test(label(e) || e.textContent.trim()),
      ) &&
      ![...document.querySelectorAll("a")].some(
        (e) => visible(e) && /^sign in$/i.test(e.textContent.trim()),
      )
    );
  }
  function wait(check, ms) {
    return new Promise((resolve, reject) => {
      let observer, timer, poll;
      const stop = () => {
        observer?.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
      };
      const inspect = () => {
        try {
          if (aborted)
            throw Object.assign(new Error("Stopped"), {
              code: "LOCAL_DISCONNECTED",
            });
          const value = check();
          if (value) {
            stop();
            resolve(value);
          }
        } catch (e) {
          stop();
          reject(e);
        }
      };
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      poll = setInterval(inspect, 500);
      timer = setTimeout(() => {
        stop();
        reject(
          Object.assign(new Error("Gemini did not complete in time"), {
            code: "AUTOMATION",
          }),
        );
      }, ms);
      inspect();
    });
  }
  async function recovery(data) {
    const r = await chrome.runtime.sendMessage({
      type: "recovery",
      runId: run.id,
      data,
    });
    if (r?.error) throw new Error(r.error);
    return r;
  }
  async function target(action, operate, postcondition) {
    const cached = run.locators.find((l) => l.action === action);
    const selectors = [
      ...(cached ? [cached.value] : []),
      ...(action === "composer" ? composerSelectors : ['input[type="file"]']),
    ];
    const acceptable = (e) =>
      action === "upload"
        ? e?.tagName === "INPUT" && e.type === "file"
        : (e?.tagName === "TEXTAREA" || e?.isContentEditable) && visible(e);
    for (const selector of [...new Set(selectors)]) {
      let e;
      try {
        e = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!acceptable(e)) continue;
      try {
        await operate(e);
        await postcondition(e);
        recovery({
          action: "locator",
          semantic: action,
          value: selector,
          verified: true,
        }).catch(() => {});
        return;
      } catch {
        if (selector === cached?.value)
          recovery({
            action: "locator",
            semantic: action,
            value: selector,
            verified: false,
          }).catch(() => {});
      }
    }
    const all = controls()
      .filter((e) => ["BUTTON", "INPUT", "TEXTAREA", "DIV"].includes(e.tagName))
      .slice(0, 40);
    const deterministic = all.filter(acceptable);
    let e, selector;
    if (deterministic.length === 1) {
      e = deterministic[0];
      selector =
        e.tagName.toLowerCase() +
        (label(e)
          ? `[aria-label=${JSON.stringify(label(e))}]`
          : e.getAttribute("role")
            ? `[role=${JSON.stringify(e.getAttribute("role"))}]`
            : "");
    } else {
      const candidates = all.map((v) => ({
        tag: v.tagName,
        role: v.getAttribute("role"),
        type: v.getAttribute("type"),
        label: label(v)
          .replace(/[\w.+-]+@[\w.-]+/g, "[email]")
          .slice(0, 80),
      }));
      const proposal = await recovery({
        action: "recover",
        semantic: action,
        candidates,
      });
      if (
        proposal.operation !== (action === "composer" ? "fill" : "upload") ||
        !Number.isInteger(proposal.candidateId)
      )
        throw new Error("Unsafe recovery operation");
      e = all[proposal.candidateId];
      if (!acceptable(e) || !label(e))
        throw new Error("Unsafe recovery target");
      selector = `${e.tagName.toLowerCase()}[aria-label=${JSON.stringify(label(e))}]`;
    }
    if (!e || document.querySelectorAll(selector).length !== 1)
      throw new Error("Recovery target is ambiguous");
    await operate(e);
    await postcondition(e);
    await recovery({
      action: "locator",
      semantic: action,
      value: selector,
      verified: true,
    });
  }
  function responses() {
    return [
      ...document.querySelectorAll(
        'model-response,[data-test-id="model-response"]',
      ),
    ];
  }
  async function handle(d) {
    if (d.type === "ping") return { ok: true };
    if (d.type === "verify") return { ready: signedIn() };
    if (d.type === "abort") {
      aborted = true;
      return { ok: true };
    }
    if (d.type === "start") {
      run = {
        id: d.runId,
        locators: d.locators || [],
        files: [],
        baseline: responses().length,
      };
      aborted = false;
      return { ok: true };
    }
    ensure(d.runId);
    if (d.type === "asset") {
      const a = d.asset;
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(a.contentType) ||
        a.bytes > 10485760 ||
        run.files.length >= 5
      )
        throw new Error("Invalid reference image");
      const binary = atob(a.base64),
        bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      if (bytes.length !== a.bytes) throw new Error("Reference size mismatch");
      run.files.push(new File([bytes], a.name, { type: a.contentType }));
      return { ok: true };
    }
    if (d.type === "prepare") {
      if (!signedIn())
        throw Object.assign(new Error("Google login required"), {
          code: "NEEDS_LOGIN",
        });
      if (run.files.length) {
        const previousAttachments = new Set(
          document.querySelectorAll(
            '[data-test-id="attachment-preview"],.attachment-preview,.file-preview',
          ),
        );
        await target(
          "upload",
          async (input) => {
            const transfer = new DataTransfer();
            for (const file of run.files) transfer.items.add(file);
            input.files = transfer.files;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          },
          async () =>
            wait(
              () =>
                [
                  ...document.querySelectorAll(
                    '[data-test-id="attachment-preview"],.attachment-preview,.file-preview',
                  ),
                ].filter((e) => !previousAttachments.has(e) && visible(e))
                  .length >= run.files.length,
              15000,
            ),
        ).catch((e) => {
          throw Object.assign(e, { code: "UPLOAD_FAILED" });
        });
      }
      await target(
        "composer",
        async (input) => {
          input.focus();
          if (input.tagName === "TEXTAREA") {
            Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype,
              "value",
            ).set.call(input, d.prompt);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            const selection = getSelection(),
              range = document.createRange();
            range.selectNodeContents(input);
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand("insertText", false, d.prompt);
          }
        },
        async (input) => {
          if ((input.value ?? input.innerText) !== d.prompt)
            throw new Error("Prompt entry not confirmed");
        },
      );
      run.baseline = responses().length;
      return { ok: true };
    }
    if (d.type === "submit") {
      if (
        Date.now() >= d.expiresAt ||
        sessionStorage.getItem("gemini-agent-submitted-" + run.id)
      )
        throw new Error("Submission permit expired or already used");
      const send = controls().filter(
        (e) =>
          e.tagName === "BUTTON" &&
          visible(e) &&
          /^(send|send message)$/i.test(label(e)),
      );
      if (send.length !== 1 || send[0].disabled)
        throw new Error("Send control is unavailable or ambiguous");
      sessionStorage.setItem("gemini-agent-submitted-" + run.id, "true");
      send[0].click();
      return { ok: true };
    }
    if (d.type === "wait") {
      const response = await wait(
        () => {
          ensure(d.runId);
          const r = responses()[run.baseline];
          if (!r) return null;
          const busy = controls().some(
            (e) => visible(e) && /stop/i.test(label(e)),
          );
          if (busy || document.querySelector('[aria-busy="true"]')) return null;
          const text = r.textContent.toLowerCase();
          if (/captcha|unusual activity|usage limit|try again later/.test(text))
            throw Object.assign(new Error("Google restriction"), {
              code: "RESTRICTED",
            });
          const complete =
            [...r.querySelectorAll("button")].some(
              (e) => visible(e) && /download|copy/i.test(label(e)),
            ) || r.querySelector('[data-test-id="response-complete"]');
          return complete ? r : null;
        },
        Math.min(900000, d.timeoutMs),
      ).catch((e) => {
        if (d.allowPending && e.code === "AUTOMATION") return null;
        throw e;
      });
      if (!response) return { pending: true };
      const images = [...response.querySelectorAll("img")].filter(visible);
      if (!images.length)
        throw Object.assign(new Error("No generated image"), {
          code: "NO_IMAGE",
        });
      run.response = response;
      run.images = images;
      return { images: images.map((e) => e.currentSrc || e.src) };
    }
    if (d.type === "download") {
      const image = run.images?.[d.index];
      if (!image || !run.response?.contains(image))
        throw new Error("Image is not in the current response");
      const local = [...image.parentElement.querySelectorAll("button")].filter(
        (e) => visible(e) && /download/i.test(label(e)),
      );
      const all = [...run.response.querySelectorAll("button")].filter(
        (e) => visible(e) && /download/i.test(label(e)),
      );
      const button =
        local.length === 1
          ? local[0]
          : run.images.length === 1 && all.length === 1
            ? all[0]
            : null;
      if (!button)
        throw Object.assign(new Error("No associated download action"), {
          code: "NO_DOWNLOAD_ACTION",
        });
      button.click();
      return { ok: true };
    }
    throw new Error("Unknown browser command");
  }
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    handle(request)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          error: {
            code: error.code || "AUTOMATION",
            message: "Gemini action failed; inspect the local browser",
          },
        }),
      );
    return true;
  });
})();
