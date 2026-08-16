// src/compat/dsh-0.1/session.ts
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage
} from "@deepseek-ai/dsh-llm";
import {
  Session
} from "@deepseek-ai/dsh-session";
import {
  deriveEventMessage,
  foldSurface
} from "@deepseek-ai/dsh-session/surface";
function textBlock(text) {
  return { type: "text", text };
}
function magicUserMessage(content, source, extraBlocks = []) {
  return createUserMessage({
    content: [textBlock(content), ...extraBlocks],
    source
  });
}
function appendMessage(session, message) {
  return session.append("user/message", message, { surfaceOp: "append" }).seq;
}
function replaceSurfaceRange(session, start, end, message, sourceEventSeqs) {
  const event = session.append("user/message", message, {
    surfaceOp: { op: "replace", start, end },
    sourceEventSeqs: [...sourceEventSeqs]
  });
  return event.seq;
}
function surfaceNodes(session) {
  return session.surface.nodes;
}
function surfaceGeneration(session) {
  return session.surface.replaceGeneration;
}

export { createAssistantMessage, createToolResultMessage, createUserMessage, Session, deriveEventMessage, foldSurface, textBlock, magicUserMessage, appendMessage, replaceSurfaceRange, surfaceNodes, surfaceGeneration };
