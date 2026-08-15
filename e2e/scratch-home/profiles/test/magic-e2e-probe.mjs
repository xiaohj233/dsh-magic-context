/**
 * E2E probe (scratch only): create one agent that JOINS the magic-standard
 * preset through the official `agentPresets.compose(agentCtx)` setup hook
 * (the same call the web app's session creation makes), drive one step, and
 * print durable evidence of the Magic planes:
 *   - agent entry activation (probe console.error from the plugin apply);
 *   - session_projects / session_meta rows written under harness='dsh';
 *   - the injected knowledge message in the session log.
 *
 * The probe is mounted via a --patch overlay as a local file row
 * (`./magic-e2e-probe.mjs`), so no DSH source is touched.
 */
export const name = "magic-e2e-probe";
export const inject = ["agents", "agentPresets", "agentDefaultModel", "sessions", "loader", "appExit"];

export function apply(ctx) {
  ctx.effect(async () => {
    try {
      await ctx.loader?.await?.();
      const agents = ctx.get("agents");
      const presets = ctx.get("agentPresets");
      const defaultModel = ctx.get("agentDefaultModel");
      const sessions = ctx.get("sessions");
      const appExit = ctx.get("appExit");
      if (!agents || !presets || !defaultModel || !sessions || !appExit) {
        console.error("PROBE: missing services");
        appExit?.(2);
        return;
      }
      const { SessionId } = await import("@deepseek-ai/dsh-session");
      const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
      const selection = defaultModel.currentSelection();
      // Unique per run: a fixed id collides with the previous run's persisted
      // log ("already has a persisted log on disk that does not match").
      const sessionId = SessionId(`session-e2e-probe-${Date.now()}`);
      const { agent } = await agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          const joined = await presets.mount(agentCtx);
          console.error(`PROBE: agent joined preset "${joined.id}"`);
        },
      });
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "hello from magic e2e probe" }],
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
      // The knowledge baseline is injected during the first pre-step but only
      // materializes as a session event with the NEXT pre-step batch — with a
      // single (auth-failing) step the injected event stays queued, so the
      // durable evidence of the gate is the session_meta/session_projects rows
      // written under harness='dsh' (checked via e2e/inspect-db.ts).
      await sessions.flush(agent.session);

      const events = agent.session.events;
      const magicMessages = events.filter(
        (e) =>
          e.type === "user/message" &&
          (e.data?.source ?? e.data?.message?.source)?.plugin === "magic-context",
      );
      console.error(
        `PROBE: session=${agent.id} events=${events.length} magicMessages=${magicMessages.length}`,
      );
      if (magicMessages.length > 0) {
        const src = magicMessages[0].data?.source ?? magicMessages[0].data?.message?.source;
        console.error(`PROBE: first magic source=${JSON.stringify(src)}`);
        console.error(`PROBE: first magic text=${JSON.stringify((magicMessages[0].data?.content?.[0]?.text ?? "").slice(0, 120))}`);
      }
      appExit(0);
    } catch (error) {
      console.error(`PROBE: FAILED ${error?.stack ?? error}`);
      appExit?.(3);
    }
  });
}
