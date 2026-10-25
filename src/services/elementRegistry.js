import { ElementLocator } from "../models/index.js";
import { AppError } from "../utils/errors.js";
const semantics = {
  composer: [
    [
      '[contenteditable="true"][role="textbox"]',
      'textarea[aria-label*="prompt" i]',
    ],
  ],
  send: [['button[aria-label="Send message"]', 'button[aria-label="Send"]']],
  newChat: [['a[aria-label="New chat"]', 'button[aria-label="New chat"]']],
  upload: [['input[type="file"]']],
};
export class ElementRegistry {
  constructor(page, recovery) {
    this.page = page;
    this.recovery = recovery;
  }
  async execute(action, operation, value, postcondition) {
    if (!["click", "fill", "upload"].includes(operation))
      throw new AppError("ACTION", "Unsupported operation");
    const cached = await ElementLocator.findOne({ context: "gemini", action });
    const selectors = [
      ...(cached ? [cached.value] : []),
      ...(semantics[action]?.[0] || []),
    ];
    for (const selector of [...new Set(selectors)]) {
      try {
        const target = this.page.locator(selector).first();
        if (!(await target.count())) continue;
        await this.perform(target, operation, value);
        await postcondition(target);
        await this.cache(action, selector, cached);
        return;
      } catch {
        if (cached?.value === selector)
          await ElementLocator.updateOne(
            { _id: cached._id },
            { $inc: { failures: 1 } },
          );
      }
    }
    // Candidate metadata excludes contenteditable text, user content, cookies and screenshots.
    const all = this.page.locator('button,input[type="file"],[role="textbox"]');
    const candidates = await all.evaluateAll((nodes) =>
      nodes.slice(0, 40).map((n) => ({
        tag: n.tagName,
        role: n.getAttribute("role"),
        label: n.getAttribute("aria-label") || n.getAttribute("title") || "",
        type: n.getAttribute("type"),
      })),
    );
    const discovered = candidates.filter((c) =>
      action === "composer"
        ? c.role === "textbox"
        : action === "upload"
          ? c.tag === "INPUT" && c.type === "file"
          : action === "newChat"
            ? c.tag === "BUTTON" && /^new (chat|conversation)$/i.test(c.label)
            : false,
    );
    if (discovered.length === 1) {
      const c = discovered[0];
      const selector = c.label
        ? `${c.tag.toLowerCase()}[aria-label=${JSON.stringify(c.label)}]`
        : `${c.tag.toLowerCase()}[role=${JSON.stringify(c.role)}]`;
      const target = this.page.locator(selector);
      if ((await target.count()) === 1) {
        try {
          await this.perform(target, operation, value);
          await postcondition(target);
          await this.cache(action, selector, cached);
          return;
        } catch {
          /* Bounded recovery follows a failed deterministic postcondition. */
        }
      }
    }
    const p = await this.recovery.choose(action, candidates);
    if (p.operation !== operation)
      throw new AppError(
        "RECOVERY_OPERATION",
        "Recovery operation does not match requested action",
      );
    const c = candidates[p.candidateId];
    if (
      !c ||
      !c.label ||
      !["BUTTON", "INPUT", "TEXTAREA", "DIV"].includes(c.tag)
    )
      throw new AppError(
        "RECOVERY_TARGET",
        "Unsafe or unstable recovery target",
      );
    const selector = `${c.tag.toLowerCase()}[aria-label=${JSON.stringify(c.label)}]`;
    const target = this.page.locator(selector);
    if ((await target.count()) !== 1)
      throw new AppError("RECOVERY_TARGET", "Recovery target is ambiguous");
    await this.perform(target, operation, value);
    await postcondition(target);
    await this.cache(action, selector, cached);
  }
  async perform(target, operation, value) {
    if (operation === "click") await target.click({ timeout: 5000 });
    if (operation === "fill") await target.fill(value, { timeout: 5000 });
    if (operation === "upload")
      await target.setInputFiles(value, { timeout: 5000 });
  }
  async cache(action, value, old) {
    await ElementLocator.findOneAndUpdate(
      { context: "gemini", action },
      {
        $set: { type: "css", value, lastVerified: new Date() },
        $inc: { successes: 1 },
        $push: {
          history: {
            $each: [
              {
                value: old?.value || value,
                type: "css",
                at: new Date(),
                verified: true,
              },
            ],
            $slice: -20,
          },
        },
      },
      { upsert: true },
    );
  }
}
