export function navigationTarget(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new Error("Enter a URL or search terms");
  const input = value.trim();
  // Preserve explicit schemes so unsafe ones are rejected, never executed.
  if (
    /^[a-z][a-z\d+.-]*:/i.test(input) &&
    !/^([^\s/:]+|\[[^\]]+\]):\d+(?:[/?#]|$)/.test(input)
  )
    return input;
  if (!/\s/.test(input)) {
    try {
      const candidate = new URL(`https://${input}`);
      if (
        candidate.hostname.includes(".") ||
        candidate.hostname === "localhost" ||
        candidate.hostname.startsWith("[")
      )
        return candidate.href;
    } catch {}
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}
