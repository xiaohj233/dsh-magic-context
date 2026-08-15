import {
  log
} from "./agent-amr6x35h.js";
import"./agent-wckvcay0.js";

// ../plugin/src/shared/safe-notification-target.ts
var DEFAULT_TITLE_RE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isDefaultSessionTitle(title) {
  return DEFAULT_TITLE_RE.test(title);
}
async function readSessionTitle(client, sessionId) {
  try {
    const c = client;
    if (typeof c.session?.get !== "function")
      return null;
    const raw = await Promise.resolve(c.session.get({ path: { id: sessionId } }));
    const obj = raw;
    const title = obj && typeof obj === "object" ? obj.data?.title ?? obj.title : undefined;
    return typeof title === "string" ? title : null;
  } catch {
    return null;
  }
}
async function waitForSafeNotificationTarget(client, sessionId, options) {
  const attempts = Math.max(1, options?.attempts ?? 4);
  const delayMs = options?.delayMs ?? 15000;
  for (let attempt = 0;attempt < attempts; attempt += 1) {
    const title = await readSessionTitle(client, sessionId);
    if (title === null)
      return "safe";
    if (!isDefaultSessionTitle(title))
      return "safe";
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  log(`[magic-context] notification skipped: session ${sessionId} still has its default title (would suppress title generation); will retry on a later startup`);
  return "skip";
}
export {
  waitForSafeNotificationTarget,
  isDefaultSessionTitle
};
