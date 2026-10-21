// Copies the call screens' CSS (ConversationsCalls.css, ConversationsAiCall.css) into public/chat/chat.css, whose CSP forbids inline <style>.
//   node scripts/sync-chat-css.mjs          rewrite the generated block
// server/tests/chat-assets.test.ts fails when the copy is stale.
import { readFileSync, writeFileSync } from "node:fs";
const dir = new URL("../public/chat/", import.meta.url);
const load = (f) => { const m = { exports: {} }; new Function("module", readFileSync(new URL(f, dir), "utf8"))(m); return m.exports.css; };
const MARK = "/* ai calls: generated";
let css = readFileSync(new URL("chat.css", dir), "utf8");
const i = css.indexOf(MARK);
if (i >= 0) css = css.slice(0, i).replace(/\n*$/, "\n");
css += `\n${MARK} from public/chat/aicall.js (ConversationsAiCall.css); keep in step: node scripts/sync-chat-css.mjs (server/tests/chat-assets.test.ts checks it) */\n${load("aicall.js")}\n`;
writeFileSync(new URL("chat.css", dir), css);
