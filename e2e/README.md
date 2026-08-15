# E2E harness — Magic Context × DSH (scratch, isolated)

A fully scratch `DSH_HOME` + headless profile + local DSH install that mounts
the `magic-standard` thin preset and drives a probe agent through the official
`agentPresets.mount()` setup hook. **No DSH source is modified and — since the
2026-08-15 hardening — no global/npm-global install is touched either**: the
scratch home resolves every `@deepseek-ai/*` package against its OWN local copy
(`e2e/dsh-install`), and the probe's Magic SQLite lives under
`e2e/scratch-data` (via `MAGIC_CONTEXT_TEST_DATA_DIR`).

## Layout

| Path | Role |
|---|---|
| `scratch-home/` | Scratch `DSH_HOME` (`--anonymous-user-id`, profiles, sessions) |
| `scratch-home/profiles/test/` | Headless profile: bundles = base + headless + `dsh-magic-context` (link: into the plugin source tree) |
| `scratch-home/profiles/node_modules/` | Profile dependency tree — **all 229 `@deepseek-ai/*` entries are junctions into `e2e/dsh-install/node_modules/`** (same physical copies the launcher loads — class identity is load-bearing) |
| `scratch-home/.agent-presets/magic-standard/` | Generated thin preset (run `dsh-magic-context setup` to regenerate) |
| `dsh-install/` | **Local, isolated DSH 0.1.0-rc.6 install** (copied from the npm-global install; gitignored). Launcher: `node e2e\dsh-install\lib\bin.js` |
| `scratch-data/` | Magic SQLite + liveness markers for the probe runs (gitignored volatile files) |
| `overlay-magic-default.yml` | `--patch` overlay: `agent-presets` roster (default = magic-standard) + the probe plugin row |
| `inspect-db.ts` / `read-sessions.ts` | Verification helpers (bun) |
| `magic-e2e-probe.mjs` | The probe (unique session id per run; drives one step) |

## Why the junction mesh matters (class identity)

The loader, `cordis-plugin-include`, `dsh-agent-presets`, `@deepseek-ai/cordis`
and the core harness module must be SINGLE module instances across the boot
composition, the mounted preset tree and the adapter's own bundles. When the
adapter package is linked into the profile as a SOURCE-TREE junction (as here),
its runtime imports resolve from the package's own `node_modules` (bun store)
— copies that are NOT the profile's — and two hard failures result:

1. `MagicPresetInclude` (the no-write include entry) carries a DIFFERENT
   `EntryGroup.key` symbol than the loader → the loader interpolates the
   include config instead of keeping it literal → patches silently lost
   (compaction-basic never disabled, magic rows never mounted).
2. The host and agent bundles each inline their own core harness module →
   the host's `setDshHarness()` never reaches the agent-side storage writes →
   rows attributed `harness='opencode'`.

Both were fixed: the adapter's `node_modules/@deepseek-ai/*` is junctioned to
the profile copies, and the agent plane calls `setDshHarness()` itself. A real
install (package inside the profile's node_modules) does not need the junctions
— this document exists so the scratch topology never silently regresses.

## Setup / repair of the local DSH install

The local install was materialized from the npm-global install (which is
otherwise the reference for compat research and must stay pristine):

```powershell
# recreate e2e/dsh-install (only if missing/corrupt — 255 MB)
robocopy D:\Dev\DevEnv\Node\npm-global\node_modules\@deepseek-ai\dsh e2e\dsh-install /E /NFL /NDL /NJH /NP
```

Repoint every profile junction to the local install (idempotent):

```powershell
$prof = "D:\Code\magic-context-for-dsh\e2e\scratch-home\profiles\node_modules"
$local = "D:\Code\magic-context-for-dsh\e2e\dsh-install\node_modules"
foreach ($d in Get-ChildItem $prof -Directory) {
  $i = Get-Item $d.FullName
  if ($i.LinkType -and $i.Target -like "D:\Dev\DevEnv\Node\npm-global*") {
    $rel = $i.Target.Substring($i.Target.IndexOf("node_modules") + "node_modules".Length).TrimStart("\")
    Remove-Item $d.FullName -Force
    New-Item -ItemType Junction -Path $d.FullName -Target (Join-Path $local $rel) | Out-Null
  }
}
```

Same for the adapter package's own `node_modules/@deepseek-ai/*` (they must
point at the PROFILE copies, not the bun store):

```powershell
$pkg = "D:\Code\magic-context-download\magic-context-master\packages\dsh-plugin\node_modules\@deepseek-ai"
foreach ($d in Get-ChildItem $pkg -Directory) {
  $t = Join-Path $prof "@deepseek-ai\$($d.Name)"
  if (Test-Path $t) {
    $i = Get-Item $d.FullName
    if ($i.LinkType) { Remove-Item $d.FullName -Force }
    New-Item -ItemType Junction -Path $d.FullName -Target $t | Out-Null
  }
}
```

## Run the E2E probe

```powershell
$env:DSH_HOME = "D:\Code\magic-context-for-dsh\e2e\scratch-home"
$env:MAGIC_CONTEXT_TEST_DATA_DIR = "D:\Code\magic-context-for-dsh\e2e\scratch-data"
$env:DSH_TELEMETRY_DISABLED = "1"
# Real-LLM runs: source the key from the main configuration instead of a dummy
# (e.g. $env:DEEPSEEK_API_KEY = (Get-Content "$env:USERPROFILE\.dsh\credentials\..." ...)
$env:DEEPSEEK_API_KEY = "dummy"

# 1. regenerate the thin preset (setup finds the LOCAL install via the home
#    fallback anchor), then verify with doctor
node packages\dsh-plugin\dist\cli.js setup --profile test
node packages\dsh-plugin\dist\cli.js doctor --profile test

# 2. boot the LOCAL launcher with the overlay + probe
node e2e\dsh-install\lib\bin.js --profile test --patch e2e\overlay-magic-default.yml "probe"

# 3. verify durable evidence (harness='dsh' rows, cached m0, canonical keys)
bun e2e\inspect-db.ts
```

Expected probe output:

```
PROBE: agent joined preset "magic-standard"
dsh: AUTH: Authentication Fails, ... (dummy key — expected)
PROBE: session=session-e2e-probe-<ts> events=17 magicMessages=0
```

`magicMessages=0` is EXPECTED for a single auth-failing step: the knowledge
baseline is injected during the first pre-step but materializes as a session
event only with the NEXT pre-step batch (DSH "inject, do not rewrite"
semantics). The durable gate evidence is the `session_meta` /
`session_projects` rows under `harness='dsh'` with canonical
`dsh:<home-hash>:<session-id>` keys and a non-null `cached_m0_bytes`.

## Stock preset integrity guard

The raw `cordis-plugin-include` write-back truncated the SHIPPED stock preset
to `[]` on the first agent teardown (DSH loader behavior; `dsh-agent-presets`
defends with `PresetTree.write()` no-op). The thin preset therefore mounts the
stock file through `MagicPresetInclude` (dist/entries/preset-include.js,
`write()` no-op) and doctor fails the preset check if the include row names
the raw include. Verify after any run:

```powershell
Get-FileHash D:\Code\magic-context-for-dsh\e2e\dsh-install\config\agent-presets\standard\agent.cordis.yml
# expect CB98756A9ED76CA351A45A0BA138A97BF0AB7EEAD4FE2F1E9D1C9F9EC97937F0 (13047 bytes)
```

If the file is ever truncated again, restore from the pristine tarball copy:

```powershell
npm pack @deepseek-ai/dsh@0.1.0-rc.6 --pack-destination <tmp>
tar -xzf <tmp>\deepseek-ai-dsh-0.1.0-rc.6.tgz -C <tmp>
Copy-Item <tmp>\package\config\agent-presets\standard\agent.cordis.yml e2e\dsh-install\config\agent-presets\standard\agent.cordis.yml
```

## Real-install test (2026-08-15)

A second, REAL installation path was exercised with a **packed tarball** instead
of a source-tree link, against the REAL npm registry dependency tree:

- `e2e/dsh-real-install/` (gitignored) — a real `npm install --prefix
  @deepseek-ai/dsh@0.1.0-rc.6` install (registry-resolved, no junctions).
  NOTE: (a) this minimal npm tree cannot BOOT dsh itself (`exit 13` unsettled
  await) and (b) it is NOT a complete module graph (npm re-installs can drop
  transitive deps like `diff`/`yaml`/`zod`) — do NOT use it as the stock
  preset source; point setup at the full global install instead.
- `e2e/real-home/` (gitignored) — a real `DSH_HOME` (copied `settings.yaml` +
  `.credentials.yaml` from the user's global home) with profile `install-test`:
  dependencies = `dsh-magic-context` from a **packed tgz**
  (`e2e/.tgz/dsh-install-test*.tgz`; the `workspace:*` adapter dep was rewritten
  to a `file:` tgz reference — the pre-publish step), plus the user's
  `dsh-pi-ai-compat` (file: into the web profile install) and
  `@deepseek-ai/dsh-llm-pi-ai` + `dsh-agent-default-model` + `dsh-agent-loop`
  for the local-relay model route (`bendi` / `deepseek-v4-flash` @
  127.0.0.1:13000).
- **Verified end-to-end (closed loop)**: `npm install` → `setup` (thin preset,
  stock sourced from the FULL global install) → `doctor` → probe run against
  the REAL shared SQLite (`C:\Users\<user>\.local\share\cortexkit\...`):
  `agent joined preset "magic-standard"`, **`magicMessages=4`** with a real
  `mc-op:*` knowledge baseline, `§N§` tags written, `session_meta`
  `harness='dsh'` + m0 bytes, and the LOCAL RELAY model (bendi,
  deepseek-v4-flash) answered with the Magic-injected context in its reply.
- **Findings that only this test could surface**:
  1. `settings.yaml` MUST actually live in `DSH_HOME` (a copy-step bug silently
     sent it to the user home dir; without it the model route falls back to
     `deepseek-official` and the "QUOTA" error comes from the OFFICIAL key, not
     the relay).
  2. The thin preset's stock `path` must resolve in a COMPLETE dsh module
     graph (the minimal `npm --prefix` tree lacks transitive deps; the loader
     expands the stock file from that directory).
  3. `file://` include entries are the correct design: bundle-name subpaths
     resolve from the stock directory's module walk, which never reaches the
     profile's node_modules (the preset.ts comment was right).
  4. npm caches `file:` tgz by path — bump the tgz name when iterating.

Pre-publish checklist proven here: publish the adapter package first (or
rewrite the `workspace:*` dep), and instruct users to install through the
full DSH installation (pnpm/dsh plugin or a complete node_modules graph).
