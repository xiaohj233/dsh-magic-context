import"./agent-wckvcay0.js";

// src/compat/dsh-0.1/compaction.ts
import {
  BasicCompactionEngine
} from "@deepseek-ai/dsh-compaction-basic";
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore
} from "@deepseek-ai/dsh-compaction";
class MagicCompactionEngine extends BasicCompactionEngine {
  magicSummarize;
  constructor(ctx, config) {
    super(ctx, { ...config, auto: config.auto ?? true });
    this.magicSummarize = config.summarize;
  }
  summarize(input, agent, signal) {
    const hook = this.magicSummarize ?? readHostSummarizeHook(this.ctx);
    if (hook === undefined) {
      throw new Error("magic-context: compaction summarize hook unavailable (agent plane not wired?)");
    }
    return hook(input, agent, signal);
  }
}
function readHostSummarizeHook(ctx) {
  const host = ctx.get("magicContextHost");
  const hook = host?.summarizeHook?.();
  return typeof hook === "function" ? hook : undefined;
}

// src/entries/compaction.ts
var compaction_default = MagicCompactionEngine;
export {
  compaction_default as default,
  MagicCompactionEngine
};
