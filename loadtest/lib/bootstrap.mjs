import { sleep } from "./stats.mjs";

const ORIGIN = "http://shop.example.com";

export async function json(url, init = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${r.status} ${text.slice(0, 200)}`);
  return body;
}

/** Create a workspace with an owner and an embed token. */
export async function createWorkspace(baseUrl) {
  const email = `owner-${Date.now()}-${Math.floor(Math.random() * 1e6)}@load.test`;
  const reg = await json(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "loadtest-password-1", name: "Load Owner", workspace_name: "Load Co" }),
  });
  const bearer = reg.token ?? reg.access_token;
  const auth = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
  const tok = await json(`${baseUrl}/api/tokens`, { method: "POST", headers: auth, body: JSON.stringify({ domain: "shop.example.com" }) });
  const ws = reg.workspace?.id ?? reg.workspaces?.[0]?.id;
  return { wsId: ws, ownerToken: bearer, embedToken: tok.token, auth };
}

/** Create `count` visitor sessions, each with one open conversation. Spread across `urls` round-robin. */
export async function createVisitors({ urls, embedToken, count, concurrency = 48, prefix = "v", onProgress }) {
  const out = new Array(count);
  let next = 0;
  let failures = 0;
  async function one(i) {
    const base = urls[i % urls.length];
    const device = `${prefix}-${String(i).padStart(7, "0")}-device`;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const s = await json(`${base}/public/sessions`, {
          method: "POST",
          headers: { "x-api-key": embedToken, origin: ORIGIN, "x-device-id": device, "content-type": "application/json" },
          body: JSON.stringify({ name: `Visitor ${i}` }),
        });
        const headers = { "x-support-session": s.session_token, "x-device-id": device, origin: ORIGIN, "content-type": "application/json" };
        const room = await json(`${base}/public/rooms`, { method: "POST", headers, body: "{}" });
        out[i] = { session: s.session_token, device, roomId: room.room?.id ?? room.id ?? room.data?.id, wsId: s.workspace_id };
        return;
      } catch (e) {
        if (attempt === 3) {
          failures++;
          if (failures < 5) console.error("bootstrap failure:", e.message);
        } else await sleep(100 * (attempt + 1));
      }
    }
  }
  async function loop() {
    while (true) {
      const i = next++;
      if (i >= count) return;
      await one(i);
      if (onProgress && i % 500 === 0) onProgress(i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, loop));
  return { visitors: out.filter(Boolean), failures };
}

export { ORIGIN };
