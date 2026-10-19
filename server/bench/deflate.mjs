// permessage-deflate cost/benefit on realistic payloads: node bench/deflate.mjs
// Uses the same zlib settings the `ws` library uses for permessage-deflate (raw deflate, default level).
import { deflateRawSync } from "node:zlib";
import os from "node:os";

const msg = (n, text) => ({
  message: {
    id: "msg_01a155fc529c0000b8cd8ba0", room_id: "room_01a155fc5296000094f5ceef", seq: n, kind: "text", source: "dm",
    content: text, content_text: text, format: "text", created_at: "2026-10-19T21:01:47.705Z", updated_at: "2026-10-19T21:01:47.705Z",
    client_msg_id: `c1234-${n}`, status: "sent", read: false, attachments: [], mentions: [],
    sender: { type: "contact", id: "con_01a155fc527f00000145d945", name: "Visitor 12" },
  },
  room: { id: "room_01a155fc5296000094f5ceef", status: "open", last_message_at: "2026-10-19T21:01:47.705Z", unread_count: 3, priority: 0, assignees: [{ id: "mem_01a1", name: "Olivia Owner" }], tags: ["billing"], snippet: text.slice(0, 120) },
});
const texts = {
  "short chat line (30 B)": "Hi, can you help with my order?",
  "typical message (280 B)": "Hello, I ordered a pair of running shoes last Tuesday (order #48213) and the tracking page still says 'label created'. Could you check whether the parcel has actually shipped? I am travelling from Friday so a delivery before then would be ideal. Thanks!",
  "long email-ish (3 KB)": ("Thanks for getting back to me. Please find the details below. ".repeat(50)).slice(0, 3000),
};
const N = 20000;
console.log(`machine: ${os.cpus()[0].model} x${os.cpus().length}, node ${process.version}, ${new Date().toISOString().slice(0, 10)}`);
console.log("payload                         raw B   deflated B  ratio   us/msg(compress)");
for (const [name, t] of Object.entries(texts)) {
  const raw = Buffer.from(JSON.stringify(msg(7, t)));
  const out = deflateRawSync(raw);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) deflateRawSync(raw);
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  console.log(`${name.padEnd(30)} ${String(raw.length).padStart(6)} ${String(out.length).padStart(10)}  ${(out.length / raw.length).toFixed(2)}   ${us.toFixed(1)}`);
}

// per-connection memory: ws keeps one deflate and one inflate context per socket for the life of the connection
import { createDeflateRaw, createInflateRaw } from "node:zlib";
const rss0 = process.memoryUsage().rss;
const keep = [];
for (let i = 0; i < 1000; i++) {
  const d = createDeflateRaw();
  d.write(Buffer.from("warm up the context ".repeat(10)));
  const f = createInflateRaw();
  keep.push(d, f);
}
await new Promise((r) => setTimeout(r, 200));
console.log(`\n1000 deflate+inflate contexts: +${Math.round((process.memoryUsage().rss - rss0) / 1024 / 1024)} MB RSS  (~${Math.round((process.memoryUsage().rss - rss0) / 1024 / 1000)} KB per connection)`);
process.exit(0);
