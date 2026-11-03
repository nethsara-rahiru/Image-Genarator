// Fixed local program only. Model responses never become JavaScript/selectors.
export function pageOperation(request) {
  const url = new URL(location.href);
  const allowed = request.origins || {
    gemini: "https://gemini.google.com",
    google: "https://accounts.google.com",
  };
  const site =
    url.origin === allowed.gemini
      ? "gemini"
      : url.origin === allowed.google
        ? "google"
        : "blocked";
  const visible = (element) =>
    !!element &&
    !!element.getClientRects().length &&
    getComputedStyle(element).visibility !== "hidden" &&
    !element.disabled;
  const all = (selector) =>
    [...document.querySelectorAll(selector)].filter(visible);
  const label = (element) =>
    (
      element.getAttribute("aria-label") ||
      element.innerText ||
      element.value ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ");
  const buttons = all("button,[role=button],[role=link],a");
  const texts = document.body?.innerText || "";
  const restricted =
    site === "google" &&
    (/captcha|recaptcha|security key|passkey|check your phone|tap yes|couldn.t sign you in|browser or app may not be secure|too many attempts|unusual activity/i.test(
      texts,
    ) ||
      !!document.querySelector(
        'iframe[src*="recaptcha"],iframe[src*="captcha"]',
      ) ||
      !/^\/(?:v3\/signin|signin|ServiceLogin|AccountChooser|InteractiveLogin)(?:[/?]|$)/.test(
        url.pathname,
      ));
  const safeNames = new Map([
    ["sign in", "signin"],
    ["use another account", "another"],
    ["next", "next"],
  ]);
  const candidates = buttons
    .map((element, index) => ({
      element,
      id: "c" + index,
      action: safeNames.get(label(element).toLowerCase()),
    }))
    .filter((c) => c.action)
    .slice(0, 24);
  const inputs = all("input");
  const error =
    !!document.querySelector('[aria-invalid="true"]') ||
    all('[role="alert"]').some((e) => e.textContent.trim());
  let kind = "unknown",
    input;
  if (site === "blocked") kind = "blocked";
  else if (document.readyState !== "complete") kind = "loading";
  else if (site === "gemini") {
    const account =
      buttons.some((e) =>
        /^google account\s*:/i.test(e.getAttribute("aria-label") || ""),
      ) || all('a[href^="https://myaccount.google.com/"]').length > 0;
    const editor =
      all('[contenteditable="true"],[role="textbox"],textarea').length > 0;
    const signin = candidates.some((c) => c.action === "signin");
    kind =
      account && editor && !signin
        ? "signed_in"
        : signin && !account
          ? "signed_out"
          : "unknown";
  } else if (restricted) kind = "security_check";
  else {
    input = inputs.find((e) => e.type === "password" && e.name === "Passwd");
    if (input) kind = "password";
    else {
      input = inputs.find(
        (e) =>
          e.id === "identifierId" ||
          (e.type === "email" && e.name === "identifier"),
      );
      if (input) kind = "email";
      else {
        input = inputs.find(
          (e) =>
            e.autocomplete === "one-time-code" ||
            ["totpPin", "idvPin"].includes(e.name),
        );
        if (input) kind = "verification";
        else if (candidates.some((c) => c.action === "another"))
          kind = "account_chooser";
      }
    }
  }
  if (request.operation === "fill") {
    if (
      site !== "google" ||
      restricted ||
      kind !== request.kind ||
      !input ||
      input.readOnly ||
      !["email", "password", "verification"].includes(kind)
    )
      return { ok: false };
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, request.value);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: input.value === request.value };
  }
  if (request.operation === "click") {
    const candidate = candidates.find(
      (c) => c.id === request.id && c.action === request.action,
    );
    if (!candidate || restricted || site === "blocked") return { ok: false };
    if (
      candidate.action === "next" &&
      (!input || kind !== request.kind || !input.value)
    )
      return { ok: false };
    if (site === "gemini" && candidate.action !== "signin")
      return { ok: false };
    if (site === "google" && candidate.action === "signin")
      return { ok: false };
    if (
      candidate.element.tagName === "A" &&
      candidate.element.getAttribute("href")
    ) {
      const destination = new URL(candidate.element.href, location.href);
      if (destination.username || destination.password) return { ok: false };
      if (
        destination.origin !== allowed.google &&
        destination.origin !== allowed.gemini
      )
        return { ok: false };
      if (!/^https?:$/.test(destination.protocol)) return { ok: false };
    }
    if (
      candidate.action === "next" &&
      input?.form?.action &&
      new URL(input.form.action, location.href).origin !== allowed.google
    )
      return { ok: false };
    candidate.element.click();
    return { ok: true };
  }
  // No values, URLs, account names, free text, screenshots or arbitrary attributes leave this program.
  return {
    site,
    kind,
    error: !!error,
    candidates: candidates.map(({ id, action }) => ({ id, action })),
  };
}
