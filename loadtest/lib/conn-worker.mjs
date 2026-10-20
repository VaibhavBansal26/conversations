// One load-generator process. Owns many Socket.IO client connections and reports counters to the parent over IPC.
// Correctness bookkeeping per (socket, room): every message:new must carry seq = last+1. A jump is a GAP (loss), a repeat is a DUP.
// After a reconnect the client resyncs over REST (as the web client and widget do), and anything it fetches is counted as RECOVERED.
import { io } from "socket.io-client";

const sockets = []; // {s, kind, rooms, last: Map<room, {seq,id}>, item}
const ctr = {
  connected: 0, connectErrors: 0, connectErrorSamples: {}, disconnects: 0, reconnects: 0,
  recv: 0, recvTeam: 0, recvVisitor: 0, auditMissing: 0, dup: 0, gap: 0, gapMsgs: 0, recovered: 0, resyncRequests: 0, resyncFailed: 0,
  sendUnique: 0, resent: 0, failovers: 0, sendOk: 0, sendErr: 0, sendCreatedFalse: 0, acksTimeout: 0, drained: 0, slowKicked: 0,
};
let deliveryLat = [];
let ackLat = [];
let connectLat = [];
const LAT_CAP = 20000;
const keep = (arr, v) => {
  if (arr.length < LAT_CAP) arr.push(v);
  else arr[Math.floor(Math.random() * LAT_CAP)] = v;
};
const send = (m) => process.send?.(m);
let sendTimer = null;
let sentSeq = 0;

function track(rec, msg, roomId) {
  if (!msg || msg.seq == null || !roomId) return;
  ctr.recv++;
  if (rec.kind === "team") ctr.recvTeam++; else ctr.recvVisitor++;
  if (msg.created_at) keep(deliveryLat, Date.now() - Date.parse(msg.created_at));
  const prev = rec.last.get(roomId);
  if (prev == null) {
    rec.last.set(roomId, { seq: msg.seq, id: msg.id });
    return;
  }
  if (msg.seq === prev.seq + 1) rec.last.set(roomId, { seq: msg.seq, id: msg.id });
  else if (msg.seq <= prev.seq) ctr.dup++;
  else {
    ctr.gap++;
    ctr.gapMsgs += msg.seq - prev.seq - 1;
    rec.last.set(roomId, { seq: msg.seq, id: msg.id });
  }
}

async function resync(rec) {
  // fetch everything after the last message id we saw, per room (visitors have a single room)
  if (rec.kind !== "visitor") return;
  for (const [roomId, last] of rec.last) {
    ctr.resyncRequests++;
    try {
      const r = await fetch(`${rec.item.url}/public/rooms/${roomId}/messages?after=${encodeURIComponent(last.id)}&limit=50`, {
        headers: { "x-support-session": rec.item.session, "x-device-id": rec.item.device, origin: "http://shop.example.com" },
      });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      const msgs = body.data ?? body.messages ?? [];
      let expect = last.seq + 1;
      for (const m of msgs) if (m.seq >= expect) { ctr.recovered++; expect = m.seq + 1; last.seq = m.seq; last.id = m.id; }
    } catch {
      ctr.resyncFailed++;
    }
  }
}

function connectOne(item) {
  const auth = item.kind === "team" ? { token: item.token } : { session: item.session, deviceId: item.device };
  const t0 = Date.now();
  const s = io(`${item.url}/ws/${item.wsId}`, {
    auth,
    transports: ["websocket"],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.8,
    extraHeaders: item.kind === "visitor" ? { origin: "http://shop.example.com" } : {},
  });
  const rec = { s, kind: item.kind, last: new Map(), item, everConnected: false, pending: new Map(), fails: 0, urlIdx: Math.max(0, (item.urls ?? []).indexOf(item.url)) };
  const failover = () => {
    // after two failures in a row against one node, try the next one (a balancer does this in production; the harness has none)
    if (!item.urls || ++rec.fails < 2) return;
    rec.fails = 0;
    rec.urlIdx = (rec.urlIdx + 1) % item.urls.length;
    s.io.uri = item.urls[rec.urlIdx];
    ctr.failovers++;
  };
  s.on("connect", () => {
    rec.fails = 0;
    ctr.connected++;
    // anything sent but never acknowledged is sent again with the SAME client id: the server's idempotency makes that safe
    for (const [cid, p] of rec.pending) { ctr.resent++; emitSend(rec, p.room, p.body, cid); }
    if (!rec.everConnected) keep(connectLat, Date.now() - t0);
    else {
      ctr.reconnects++;
      void resync(rec);
    }
    rec.everConnected = true;
  });
  s.on("disconnect", (reason) => {
    ctr.connected--;
    ctr.disconnects++;
    failover();
    if (reason === "io server disconnect") ctr.slowKicked++;
  });
  s.on("connect_error", (e) => {
    failover();
    ctr.connectErrors++;
    const k = String(e.data?.code ?? e.message).slice(0, 60);
    ctr.connectErrorSamples[k] = (ctr.connectErrorSamples[k] ?? 0) + 1;
  });
  s.on("server:draining", () => ctr.drained++);
  s.on("message:new", (p) => {
    const m = p?.message;
    track(rec, m, m?.room_id ?? p?.room?.id);
  });
  sockets.push(rec);
  return rec;
}

async function connectAll({ items, ratePerSec }) {
  const gap = 1000 / ratePerSec;
  let i = 0;
  const start = Date.now();
  await new Promise((resolve) => {
    const tick = () => {
      const due = Math.min(items.length, Math.floor((Date.now() - start) / gap));
      while (i < due) connectOne(items[i++]);
      if (i >= items.length) return resolve();
      setTimeout(tick, 5);
    };
    tick();
  });
}

function emitSend(rec, roomId, body, cid) {
  if (!rec.s.connected) return;
  const at = Date.now();
  rec.s.emit("message:send", { room_id: roomId, content: body, client_msg_id: cid }, (ack) => {
    if (ack?.ok === false || ack?.error) { ctr.sendErr++; return; }
    rec.pending.delete(cid);
    ctr.sendOk++;
    if (ack && ack.created === false) ctr.sendCreatedFalse++;
    keep(ackLat, Date.now() - at);
  });
}

function startSending({ ratePerSec, bytes = 64, kindFilter = "visitor", track = false }) {
  stopSending();
  const pool = sockets.filter((r) => r.kind === kindFilter);
  if (!pool.length || ratePerSec <= 0) return;
  const body = "x".repeat(Math.max(1, bytes));
  const gapMs = 1000 / ratePerSec;
  let n = 0;
  const t0 = Date.now();
  sendTimer = setInterval(() => {
    const due = Math.floor((Date.now() - t0) / gapMs);
    while (n < due) {
      const rec = pool[Math.floor(Math.random() * pool.length)];
      n++;
      if (!track && !rec.s.connected) continue;
      const roomId = rec.kind === "visitor" ? rec.item.rooms[0] : rec.item.rooms[Math.floor(Math.random() * rec.item.rooms.length)];
      const cid = `c${process.pid}-${sentSeq++}`;
      ctr.sendUnique++;
      if (track) rec.pending.set(cid, { room: roomId, body });
      emitSend(rec, roomId, body, cid);
    }
  }, 5);
}
function stopSending() {
  clearInterval(sendTimer);
  sendTimer = null;
}

function dropFraction(fraction, kind) {
  let dropped = 0;
  for (const rec of sockets) {
    if (!rec.s.connected || Math.random() >= fraction || (kind && rec.kind !== kind)) continue;
    // abrupt: kill the TCP connection under the client, like a network drop, so socket.io-client takes its reconnect path
    const ws = rec.s.io.engine?.transport?.ws;
    if (ws?.terminate) ws.terminate();
    else rec.s.io.engine?.close();
    dropped++;
  }
  return dropped;
}

function pauseReading(n) {
  let paused = 0;
  for (const rec of sockets) {
    if (paused >= n) break;
    if (rec.kind !== "team" || !rec.s.connected) continue;
    rec.s.io.reconnection(false);
    const raw = rec.s.io.engine?.transport?.ws?._socket;
    if (raw) { raw.pause(); paused++; }
  }
  return paused;
}

function snapshot(reset) {
  const lat = (a) => { const s = [...a].sort((x, y) => x - y); const p = (q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null); return { n: s.length, p50: p(0.5), p90: p(0.9), p99: p(0.99), max: s.length ? s[s.length - 1] : null }; };
  const out = { ...ctr, connectErrorSamples: { ...ctr.connectErrorSamples }, open: sockets.filter((r) => r.s.connected).length, total: sockets.length, delivery: lat(deliveryLat), ack: lat(ackLat), connect: lat(connectLat), deliveryRaw: reset ? deliveryLat : undefined };
  if (reset) {
    deliveryLat = [];
    ackLat = [];
  }
  return out;
}

process.on("message", async (m) => {
  try {
    if (m.cmd === "connect") {
      await connectAll(m);
      send({ id: m.id, ok: true });
    } else if (m.cmd === "send") {
      startSending(m);
      send({ id: m.id, ok: true });
    } else if (m.cmd === "stopSend") {
      stopSending();
      send({ id: m.id, ok: true });
    } else if (m.cmd === "drop") {
      send({ id: m.id, ok: true, dropped: dropFraction(m.fraction, m.kind) });
    } else if (m.cmd === "pause") {
      send({ id: m.id, ok: true, paused: pauseReading(m.n) });
    } else if (m.cmd === "stats") {
      send({ id: m.id, ok: true, stats: snapshot(m.reset) });
    } else if (m.cmd === "audit") {
      const before = ctr.recovered;
      await Promise.all(sockets.filter((r) => r.kind === "visitor").map((r) => resync(r)));
      ctr.auditMissing += ctr.recovered - before;
      ctr.recovered = before;
      send({ id: m.id, ok: true, missing: ctr.auditMissing });
    } else if (m.cmd === "close") {
      stopSending();
      for (const r of sockets) r.s.io.reconnection(false), r.s.close();
      send({ id: m.id, ok: true });
      setTimeout(() => process.exit(0), 200);
    }
  } catch (e) {
    send({ id: m.id, ok: false, error: String(e?.stack ?? e) });
  }
});
send({ ready: true });
