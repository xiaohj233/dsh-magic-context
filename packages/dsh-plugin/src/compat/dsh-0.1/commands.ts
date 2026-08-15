/**
 * compat/dsh-0.1/commands — DSH command-registry seam (dsh-reference §B.6).
 *
 * `@deepseek-ai/dsh-commands` is not a declared dependency of this package,
 * so its contract (`CommandDefinition` / `CommandInvocation` / `CommandResult`
 * / the `register` surface) is pinned here as a structural copy of the
 * official `lib/types/index.d.ts` / `types.d.ts`. At runtime nothing is
 * imported from the package: registration only touches the `ctx.commands`
 * service property (or the `commands` service lookup), which the host command
 * plugin provides.
 *
 * CommandResult is the model-invisible echo channel: the dispatching UI
 * renders `text` directly; it is never routed into the model context.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

/** Optional free-form input hint advertised to capable clients. */
export interface CommandInputDescriptor {
  readonly hint: string;
}

/** Expected command outcome rendered directly by the dispatching UI. */
export type CommandResult =
  | {
      readonly kind: "success";
      readonly text?: string;
      /** Earlier authoritative domain event that owns a richer presentation. */
      readonly sourceEventSeq?: number;
    }
  | {
      readonly kind: "error";
      readonly text: string;
    };

/** Invocation passed to one registered command handler. */
export interface CommandInvocation {
  /** Pairing id already written to this invocation's `command/run` event. */
  readonly commandId: unknown;
  /** Exact agent whose UI received the command. */
  readonly agent: Agent;
  /** Exact text following the registered command name, including separator whitespace. */
  readonly rawInput: string;
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal;
}

/** Plugin-owned command registration. */
export interface CommandDefinition {
  /** Lowercase command name without the leading slash. */
  readonly name: string;
  /** Human-readable summary used in discovery UI. */
  readonly description: string;
  readonly input?: CommandInputDescriptor;
  readonly recordInput?: boolean;
  /** Execute against the receiving agent without sending the command to the model. */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}

type CommandRuntimeLike = {
  register(definition: CommandDefinition): () => void;
};

/** Register a global command and return its exact disposer (reversible). */
export function registerCommand(ctx: Context, definition: CommandDefinition): () => void {
  // ctx.get() only — a property read of an undeclared service throws in the
  // cordis runtime, and `commands` is not declared in `inject` (optional).
  const commands = ctx.get("commands") as CommandRuntimeLike | undefined;
  if (commands === undefined) throw new Error("commands service unavailable");
  return commands.register(definition);
}

/** CommandResult success with text. */
export function successResult(text: string): CommandResult {
  return { kind: "success", text };
}

/** CommandResult error with text. */
export function errorResult(text: string): CommandResult {
  return { kind: "error", text };
}
