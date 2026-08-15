# dsh-magic-context

Magic Context — community port to DeepSeek Harness (DSH). A persistent DSH
plugin (Host / Agent / Client + profile bundle) that loads the shared Magic
Context SQLite store (`harness='dsh'` row isolation) and registers the `ctx_*`
tools, `/ctx-*` commands, knowledge injection, historian/dreamer scheduling,
compaction policy, and the Typert Remote surface.

> Community port. Not affiliated with the official Magic Context or DeepSeek
> projects. Upstream: https://github.com/cortexkit/magic-context (MIT).

## Install

In your DSH profile's `package.json`:

```json
{
  "dependencies": { "dsh-magic-context": "github:xiao_hj909/dsh-magic-context#v0.1.0&path:/packages/dsh-plugin" },
  "dsh": { "profile": { "bundles": ["...", "dsh-magic-context"] } }
}
```

Then `pnpm install` and restart dsh. The adapter package
(`dsh-magic-context-adapter`) is resolved automatically.

## Setup

```sh
dsh-magic-context setup   # generates the magic-standard thin preset
dsh-magic-context doctor  # verifies the install
```

Select the `magic-standard` preset for new sessions, then restart dsh. The
first session creates the shared SQLite
(`~/.local/share/cortexkit/magic-context/context.db`).

## Features

- Knowledge mode: m0/m1 baseline injection, auto-search, §N§ tags
- Context management: transcript + surface CAS (outbox saga), historian
  compartments, Magic compaction policy
- Automation: Dreamer tasks, /ctx-recomp /ctx-wrapup /ctx-session-upgrade,
  /ctx-embed, feedback bridge
- Web: status card + Remote diagnostics

See the repository README for the full feature table and constraints.

## Uninstall

Remove the dependency and the `bundles` entry, then restart dsh. The shared
SQLite and `dsh_*` adapter tables are intentionally preserved (cross-harness
data); remove `~/.dsh/.agent-presets/magic-standard/` manually if you no
longer need the preset.

## Compatibility

- DSH `0.1.0-rc.6` exact-rc (run the contract gate before upgrading)
- Magic Context 0.36.1 shared schema baseline

## License

MIT. Upstream copyright notices: see THIRD_PARTY_NOTICES.md.
