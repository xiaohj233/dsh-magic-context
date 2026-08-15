import { readdirSync } from "node:fs";
import { join } from "node:path";
// Resolve against this repo (e2e/..) so the script is portable.
const repo = new URL("..", import.meta.url).pathname.replace(/^([A-Za-z]):\//, "$1:/");
const root = join(repo, "e2e", "scratch-home", "sessions");
for (const dir of readdirSync(root)) {
  for (const sub of readdirSync(join(root, dir))) {
    const file = join(root, dir, sub, "session.jsonl.zstd");
    try {
      const buf = await Bun.file(file).arrayBuffer();
      const text = new TextDecoder().decode(buf);
      const firstLine = text.split("\n").find((l) => l.trim().length > 0);
      console.log("=== session", sub, "===");
      console.log("header:", firstLine?.slice(0, 400));
      // event types seen
      const types = new Set();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type) types.add(ev.type);
          if (ev.type === "user/message") {
            const src = ev.data?.message?.source ?? ev.data?.source;
            if (src?.plugin === "magic-context") {
              console.log("MAGIC MESSAGE FOUND:", JSON.stringify(src).slice(0, 200));
            }
          }
        } catch {}
      }
      console.log("event types:", [...types].join(","));
    } catch (error) {
      console.log("=== session", sub, "READ FAIL:", error.message);
    }
  }
}
