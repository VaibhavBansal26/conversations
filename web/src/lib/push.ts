// The browser side of Web Push (docs/NOTIFICATIONS.md): register the service worker, subscribe with the server's VAPID key, unsubscribe.
export type PushEvent = "missed_call" | "assigned" | "message";
export const pushSupported = (): boolean => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const pushPermission = (): NotificationPermission | "unsupported" => (pushSupported() ? Notification.permission : "unsupported");

export function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask for permission, register the worker and subscribe. Returns the subscription to send to the server, or why not. */
export async function subscribeThisBrowser(publicKey: string): Promise<{ ok: true; subscription: PushSubscriptionJSON } | { ok: false; reason: "unsupported" | "denied" | "failed" }> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "denied" };
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
    return { ok: true, subscription: sub.toJSON() };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export async function unsubscribeThisBrowser(): Promise<void> {
  const s = await currentSubscription();
  await s?.unsubscribe().catch(() => undefined);
}

/** Which of the member's devices is this browser (remembered locally when it subscribed). */
const KEY = "conv.push.device";
export const thisDeviceId = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const rememberDevice = (id: string | null) => {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
};
