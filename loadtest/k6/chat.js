// k6 script: visitors connect over WebSocket (raw Socket.IO v4 framing over Engine.IO v4), send messages and check acks.
// NOT RUN in this repo's environment (k6 is not installed here); it follows the protocol the node harness uses and is meant for the cloud run in docs/CLOUD-LOADTEST.md.
//
//   k6 run -e BASE=https://chat.example.com -e API_KEY=cvt_... -e ORIGIN=https://shop.example.com -e VUS=20000 -e RATE=1 k6/chat.js
//
// Each VU creates a visitor session + room over REST (setup phase per VU), opens one socket, sends one message every 1/RATE seconds and records
// ack latency. Thresholds fail the run when the SLOs from docs/SCALING.md regress.
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE || "http://localhost:3000";
const API_KEY = __ENV.API_KEY;
const ORIGIN = __ENV.ORIGIN || "https://shop.example.com";
const RATE = Number(__ENV.RATE || 0.2); // messages per second per VU
const HOLD = Number(__ENV.HOLD || 600); // seconds a VU keeps its socket open

const ackMs = new Trend("chat_ack_ms", true);
const connectMs = new Trend("chat_connect_ms", true);
const lost = new Counter("chat_acks_missing");
const connectFail = new Counter("chat_connect_failed");

export const options = {
  scenarios: {
    sockets: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || "10m", target: Number(__ENV.VUS || 1000) },
        { duration: __ENV.STEADY || "20m", target: Number(__ENV.VUS || 1000) },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "1m",
    },
  },
  thresholds: {
    chat_ack_ms: ["p(99)<400"],
    chat_connect_ms: ["p(99)<3000"],
    chat_connect_failed: ["count<100"],
    chat_acks_missing: ["count<10"],
  },
};

function session(vu) {
  const device = `k6-${vu}-${Date.now().toString(36)}-device`;
  const s = http.post(`${BASE}/public/sessions`, "{}", { headers: { "x-api-key": API_KEY, origin: ORIGIN, "x-device-id": device, "content-type": "application/json" } });
  if (s.status !== 201) return null;
  const j = s.json();
  const h = { "x-support-session": j.session_token, "x-device-id": device, origin: ORIGIN, "content-type": "application/json" };
  const r = http.post(`${BASE}/public/rooms`, "{}", { headers: h });
  if (r.status >= 300) return null;
  const room = r.json();
  return { token: j.session_token, device, ws: j.workspace_id, room: (room.room || room).id };
}

export default function () {
  const me = session(__VU);
  if (!me) {
    connectFail.add(1);
    sleep(5);
    return;
  }
  const url = `${BASE.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
  const t0 = Date.now();
  const pending = new Map();
  let ackId = 0;
  const res = ws.connect(url, { headers: { origin: ORIGIN } }, (socket) => {
    socket.on("message", (m) => {
      if (m === "2") return socket.send("3"); // engine.io ping -> pong
      if (m[0] === "0") return socket.send(`40/ws/${me.ws.replace(/^ws_/, "ws_")},${JSON.stringify({ session: me.token, deviceId: me.device })}`);
      if (m.startsWith(`40/ws/${me.ws}`)) {
        connectMs.add(Date.now() - t0);
        socket.setInterval(() => {
          const id = ++ackId;
          pending.set(id, Date.now());
          socket.send(`42/ws/${me.ws},${id}${JSON.stringify(["message:send", { room_id: me.room, content: "hello from k6", client_msg_id: `k6-${__VU}-${__ITER}-${id}-x` }])}`);
        }, 1000 / RATE);
      } else if (m.startsWith(`43/ws/${me.ws},`)) {
        const id = Number(m.slice(`43/ws/${me.ws},`.length).match(/^\d+/)[0]);
        if (pending.has(id)) {
          ackMs.add(Date.now() - pending.get(id));
          pending.delete(id);
        }
      } else if (m.startsWith("44/")) connectFail.add(1);
    });
    socket.setTimeout(() => {
      lost.add(pending.size);
      socket.close();
    }, HOLD * 1000);
  });
  check(res, { "ws upgraded": (r) => r && r.status === 101 });
}
