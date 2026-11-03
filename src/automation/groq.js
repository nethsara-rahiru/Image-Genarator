import fs from "node:fs/promises";
import path from "node:path";
import { nativeError } from "../native/common.js";
export class GroqRecovery {
  constructor(data, { fetchImpl = fetch, env = process.env, log } = {}) {
    this.file = path.join(data, "groq.json");
    this.fetch = fetchImpl;
    this.env = env;
    this.log = log;
    this.usage = { requests: 0, successes: 0, failures: 0, tokens: 0 };
  }
  async config() {
    let stored = {};
    try {
      stored = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw nativeError(
          "GROQ_CONFIG",
          "Groq configuration could not be read. Check the private data directory.",
        );
    }
    return {
      key: stored.key || this.env.GROQ_API_KEY || "",
      model: stored.model || this.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    };
  }
  async status() {
    const { key, model } = await this.config();
    return { configured: !!key, model, usage: { ...this.usage } };
  }
  async save({ key, model, clear = false }) {
    if (
      typeof model !== "string" ||
      !/^[a-zA-Z0-9_./-]{1,100}$/.test(model) ||
      (key !== undefined &&
        (typeof key !== "string" || key.length > 512 || /[\r\n]/.test(key)))
    )
      throw nativeError(
        "INVALID_INPUT",
        "Enter a valid model identifier and API key.",
      );
    const previous = await this.config();
    if (clear) await fs.rm(this.file, { force: true });
    else {
      const temp = this.file + ".tmp";
      await fs.writeFile(
        temp,
        JSON.stringify({ key: key || previous.key, model }),
        { mode: 0o600 },
      );
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.file);
    }
    return this.status();
  }
  async propose(view, signal) {
    const { key, model } = await this.config();
    if (!key) return { operation: "ask_user", reason: "not_configured" };
    // Construct a fresh allowlisted projection: no raw DOM, values, account labels, URL or screenshots.
    const candidates = (view.candidates || [])
      .filter(
        (c) =>
          /^c\d{1,4}$/.test(c.id) && ["signin", "another"].includes(c.action),
      )
      .slice(0, 16)
      .map(({ id, action }) => ({ id, action }));
    if (!candidates.length)
      return { operation: "ask_user", reason: "no_safe_targets" };
    this.usage.requests++;
    try {
      const response = await this.fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.any([
            AbortSignal.timeout(10000),
            ...(signal ? [signal] : []),
          ]),
          body: JSON.stringify({
            model,
            temperature: 0,
            max_completion_tokens: 180,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  'Choose a safe sign-in navigation candidate, wait, or ask the user. Return only JSON with exactly operation ("click", "wait", "ask_user") and candidateId (a supplied ID for click, otherwise null). Never propose code, credentials, URLs, or security-check bypasses.',
              },
              {
                role: "user",
                content: JSON.stringify({
                  site: ["gemini", "google"].includes(view.site)
                    ? view.site
                    : "unknown",
                  candidates,
                }),
              },
            ],
          }),
        },
      );
      if (!response.ok) throw new Error("Groq rejected request");
      if (Number(response.headers.get("content-length")) > 24000) {
        await response.body?.cancel();
        throw new Error("Response too large");
      }
      const reader = response.body.getReader();
      const parts = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 24000) {
            await reader.cancel();
            throw new Error("Response too large");
          }
          parts.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      const text = Buffer.concat(parts).toString();
      const result = JSON.parse(text);
      this.usage.tokens += Math.max(
        0,
        Math.min(10000, Number(result.usage?.total_tokens) || 0),
      );
      const proposal = JSON.parse(
        result.choices?.[0]?.message?.content || "null",
      );
      if (
        !proposal ||
        Object.keys(proposal).sort().join(",") !== "candidateId,operation" ||
        !["click", "wait", "ask_user"].includes(proposal.operation) ||
        (proposal.operation === "click"
          ? !candidates.some((c) => c.id === proposal.candidateId)
          : proposal.candidateId !== null)
      )
        throw new Error("Invalid proposal");
      this.usage.successes++;
      this.log?.write(
        "info",
        "browser",
        "GROQ_RECOVERY",
        "Groq returned a validated navigation proposal using sanitized candidates.",
      );
      return proposal;
    } catch {
      this.usage.failures++;
      this.log?.write(
        "warn",
        "browser",
        "GROQ_RECOVERY_FAILED",
        "Groq recovery was unavailable or returned an invalid action. Check the API key, model and network; user intervention is required.",
      );
      return { operation: "ask_user", reason: "recovery_failed" };
    }
  }
}
