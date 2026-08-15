# Magic Context for DSH

<div align="center">

**English** | [中文](./README.md)

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.6-111827.svg)
![Magic Context](https://img.shields.io/badge/Magic%20Context-0.36.1-7C3AED.svg)
![Harness](https://img.shields.io/badge/harness-dsh-5391FE.svg)
![Community](https://img.shields.io/badge/community-port-0F766E.svg)
![Tests](https://img.shields.io/badge/tests-177%2F177-brightgreen.svg)
![License](https://img.shields.io/badge/license-MIT-brightgreen.svg)

A **community port** of [Magic Context](https://github.com/cortexkit/magic-context) — tested and built in the Magic Context monorepo development worktree; this repo is the release mirror (dist prebuilt and shipped with each tag)
to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Not affiliated with the official DSH or Magic Context projects; capability
alignment is tracked in [Features](./docs/FEATURES.md).

[E2E harness](./e2e/README.md)

</div>

---

## About

An adapter layer that ports Magic Context to DSH: DSH sessions can use Magic
Context's knowledge injection, context management and memory, while sharing
**the same SQLite store** as OpenCode/Pi (`harness='dsh'` row isolation) with
zero changes to OpenCode/Pi behavior.

Use cases:

- Reuse existing Magic Context memories in DSH (shared with OpenCode/Pi).
- DSH sessions that want m0/m1 knowledge injection, §N§ tags, historian
  compaction, and Dreamer scheduled tasks.
- DSH users who want the /ctx-* tool family (search/memory/note/expand/
  reduce/embed/recomp/wrapup).

## Installation

In your DSH profile's `package.json`:

```json
{
  "dependencies": { "@xiao_hj909/magic-context-for-dsh": "github:xiao_hj909/magic-context-for-dsh#v0.1.0&path:/packages/dsh-plugin" },
  "dsh": { "profile": { "bundles": ["...", "@xiao_hj909/magic-context-for-dsh"] } }
}
```

Then run `pnpm install` (or `dsh plugin --profile <name> install`) and restart dsh.

> The adapter package (`@xiao_hj909/magic-context-for-dsh-adapter`) is resolved
> automatically by the main package's `github:` dependency — no separate install needed.

### Quick start

```sh
# 1. Generate the thin preset and verify
dsh-magic-context setup
dsh-magic-context doctor

# 2. Select the magic-standard preset for new sessions
#    Web UI: Settings → Agent preset → magic-standard
#    or settings.yaml: agent-presets.default: magic-standard

# 3. Restart dsh
```

The first session automatically creates the shared SQLite
(`~/.local/share/cortexkit/magic-context/context.db`).

## Feature overview

- **Knowledge mode**: m0/m1 baseline injection (incl. Mural images), auto-search, §N§ tags
- **Context management**: DshTranscript + SurfaceMutationCoordinator (CAS +
  outbox saga), historian background compartments, Magic compaction policy,
  cache classification SOFT+/SOFT/HARD
- **Automation**: all Dreamer tasks, Sidekick /ctx-aug, /ctx-recomp /ctx-wrapup
  /ctx-session-upgrade, /ctx-embed, feedback bridge
- **Maintenance**: setup/doctor, upgrade contract gate, no-write-back safety
  (shipped preset mounted read-only)
- **Web**: status card + Remote diagnostics endpoint

Full parity table: [docs/FEATURES.md](./docs/FEATURES.md).

## Constraints & boundaries

- No DSH source modifications; never rewrites `llm/stream messages[]`;
  OpenCode/Pi behavior unchanged.
- Compatibility baseline: DSH `0.1.0-rc.6` (run the contract gate before
  upgrading).
- Known boundaries: see [docs/FEATURES.md](./docs/FEATURES.md) (differences).

## License

MIT (same as Magic Context and DSH). Upstream copyright notices are in each
package's `NOTICE`.
