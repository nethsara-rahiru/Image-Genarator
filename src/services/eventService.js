import { AutomationEvent } from "../models/index.js";
export function sanitize(message) {
  return String(message)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(
      /(bearer|token|password|cookie|secret|key)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .slice(0, 400);
}
export async function emit(type, message, refs = {}, recovery) {
  return AutomationEvent.create({
    ...refs,
    type,
    message: sanitize(message),
    recovery,
    expiresAt: new Date(Date.now() + 30 * 86400000),
  });
}
