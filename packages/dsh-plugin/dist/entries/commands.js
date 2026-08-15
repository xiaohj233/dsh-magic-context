import {
  registerCtxCommands
} from "./agent-879wag30.js";
import"./agent-4kqj56r3.js";
import"./agent-hb5apgm1.js";
import"./agent-amr6x35h.js";
import"./agent-wckvcay0.js";

// src/entries/commands.ts
var name = "magic-context-commands";
function apply(ctx, config = {}) {
  registerCtxCommands(ctx, config);
}
var commands_default = { name, apply };
export {
  name,
  commands_default as default,
  apply
};
