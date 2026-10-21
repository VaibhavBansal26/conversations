// Screenshots of Settings > Notifications > Push notifications (3 viewports x light/dark). `npx playwright test tests/shots-push.spec.ts --project=shots`.
import { mkdirSync } from "node:fs";
import { createECDH, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loginApi } from "../support/api.mjs";
import { scrollToTop } from "../support/scroll";
import { expect, signIn, test } from "../support/fixtures";

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design");
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [{ id: "1440x900", width: 1440, height: 900 }, { id: "1024x768", width: 1024, height: 768 }, { id: "390x844", width: 390, height: 844 }] as const;
async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome/140" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
for (const vp of VIEWPORTS) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`push ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
      test("devices", async ({ page, baseURL }) => {
        const owner = await loginApi(baseURL!);
        const e = createECDH("prime256v1");
        e.generateKeys();
        const dev = await req(baseURL!, owner.token, "POST", "/push/subscriptions", { subscription: { endpoint: `http://127.0.0.1:9/push/shot-${vp.id}-${scheme}`, keys: { p256dh: e.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } }, label: "Work laptop", events: ["missed_call", "assigned"] });
        try {
          await signIn(page);
          await page.goto("/settings/notifications");
          const h = page.getByRole("heading", { name: "Push notifications" });
          await expect(h).toBeVisible();
          await scrollToTop(h);
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(OUT, `push-settings-${vp.id}-${scheme}.jpg`), type: "jpeg", quality: 82 });
        } finally {
          await req(baseURL!, owner.token, "DELETE", `/push/subscriptions/${dev.id}`).catch(() => {});
        }
      });
    });
  }
}
