import {
  registerCtxTools
} from "./agent-4kqj56r3.js";
import"./agent-hb5apgm1.js";
import"./agent-amr6x35h.js";
import"./agent-wckvcay0.js";

// src/entries/tools.ts
var name = "magic-context-tools";
function apply(ctx, config = {}) {
  registerCtxTools(ctx, config);
}
var tools_default = { name, apply };
export {
  name,
  tools_default as default,
  apply
};
