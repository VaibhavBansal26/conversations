import { fullApp } from "./helpers.js";

/** A workspace with one embed token and helpers to open visitor sessions over HTTP, for tests that drive the public widget API. */
export async function widgetWorld(env: Record<string, string> = {}, domain = "shop.example.com") {
  const f = await fullApp(env);
  const created = await f.http.post("/api/tokens", { domain }, f.token);
  const apiKey = created.body.token as string;
  const origin = `https://${domain.replace("*.", "app.")}`;
  const h = (device = "device-aaaa-0001", extra: Record<string, string> = {}) => ({ "x-api-key": apiKey, origin, "x-device-id": device, ...extra });
  const newSession = async (body: object = {}, device = "device-aaaa-0001") => {
    const r = await f.http.post("/public/sessions", body, undefined, h(device));
    return { res: r, headers: { "x-support-session": r.body.session_token ?? "", "x-device-id": device, origin } };
  };
  /** a visitor with a session and a conversation of their own */
  const visitor = async (body: object = {}, device = "device-aaaa-0001") => {
    const s = await newSession(body, device);
    const room = await f.http.post("/public/rooms", {}, undefined, s.headers);
    return { ...s, roomId: room.body.room.id as string, send: (content: string) => f.http.post(`/public/rooms/${room.body.room.id}/messages`, { content }, undefined, s.headers) };
  };
  return { ...f, apiKey, origin, h, newSession, visitor, tokenId: created.body.id as string };
}
