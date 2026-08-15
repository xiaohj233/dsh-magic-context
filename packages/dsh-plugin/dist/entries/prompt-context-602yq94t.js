import"./agent-wckvcay0.js";

// ../plugin/src/shared/prompt-context.ts
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function extractMessages(response) {
  if (Array.isArray(response))
    return response;
  if (isRecord(response) && Array.isArray(response.data))
    return response.data;
  return [];
}
function extractFromMessage(message) {
  if (!isRecord(message) || !isRecord(message.info))
    return null;
  const info = message.info;
  const modelInfo = isRecord(info.model) ? info.model : undefined;
  const agent = typeof info.agent === "string" ? info.agent : undefined;
  const providerID = typeof modelInfo?.providerID === "string" ? modelInfo.providerID : typeof info.providerID === "string" ? info.providerID : undefined;
  const modelID = typeof modelInfo?.modelID === "string" ? modelInfo.modelID : typeof info.modelID === "string" ? info.modelID : undefined;
  const variant = typeof modelInfo?.variant === "string" ? modelInfo.variant : typeof info.variant === "string" ? info.variant : undefined;
  if (!agent && (!providerID || !modelID) && !variant)
    return null;
  const out = {};
  if (agent)
    out.agent = agent;
  if (providerID && modelID)
    out.model = { providerID, modelID };
  if (variant)
    out.variant = variant;
  return out;
}
function mergeContexts(base, patch) {
  return {
    agent: base.agent ?? patch.agent,
    model: base.model ?? patch.model,
    variant: base.variant ?? patch.variant
  };
}
function isComplete(ctx) {
  return Boolean(ctx.agent && ctx.model && ctx.variant);
}
var PROMPT_CONTEXT_MESSAGE_LIMIT = 50;
async function resolvePromptContext(client, sessionId) {
  if (!client || !sessionId)
    return null;
  const c = client;
  if (typeof c.session?.messages !== "function")
    return null;
  let messages = [];
  try {
    const response = await c.session.messages({
      path: { id: sessionId },
      query: { limit: PROMPT_CONTEXT_MESSAGE_LIMIT }
    });
    messages = extractMessages(response);
  } catch {
    return null;
  }
  if (messages.length === 0)
    return null;
  let result = {};
  for (let i = messages.length - 1;i >= 0; i -= 1) {
    const ctx = extractFromMessage(messages[i]);
    if (!ctx)
      continue;
    result = mergeContexts(result, ctx);
    if (isComplete(result))
      return result;
  }
  if (!result.agent && !result.model && !result.variant)
    return null;
  return result;
}
export {
  resolvePromptContext
};
