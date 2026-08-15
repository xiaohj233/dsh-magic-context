/**
 * Subpath entry: `@xiao_hj909/magic-context-for-dsh/agent` — the AGENT-PLANE plugin
 * row the thin preset mounts (PLAN §3.1 MagicContextAgentPlugin). The loader
 * imports this module and activates the returned Cordis plugin; every side
 * effect is fiber-owned.
 */
import { apply, inject, name } from "../agent/index";
export { apply, inject, name };
export default { name, inject, apply };
