// Screenshots of Settings > Calls > Photoreal avatar (not connected; connected with an avatar and on) and the AI video call after a photoreal stream
// could not connect (the built-in face), at 3 viewports in light and dark. Uses the stack's fake provider. `npx playwright test tests/shots-photoreal.spec.ts --project=shots`.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { loginApi } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import { FAKE_SPEECH_SCRIPT } from "../support/fakeSpeech";
import { startCustomerSite } from "../support/site";
import { expect, signIn, stamp, test } from "../support/fixtures";

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design");
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [{ id: "1440x900", width: 1440, height: 900 }, { id: "1024x768", width: 1024, height: 768 }, { id: "390x844", width: 390, height: 844 }] as const;
const shot = async (page: Page, name: string, vp: string, scheme: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}-${vp}-${scheme}.jpg`), type: "jpeg", quality: 82 });
};
async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
for (const vp of VIEWPORTS) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`photoreal ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
      test("settings and the call", async ({ page, browser, baseURL }) => {
        test.setTimeout(90_000);
        const api = await loginApi(baseURL!);
        const agent = await req(baseURL!, api.token, "POST", "/agents", { name: "Aria", enabled: true, persona: "You help customers of Acme.", greeting: "", max_turns: 20 });
        await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { routing: { require_online: false }, calls: { ai: { enabled: true, idle_timeout_s: 120, daily_limit: 900, max_concurrent: 20 } } } });
        let avatarId = "";
        try {
          await signIn(page);
          await page.goto("/settings/calls");
          const h = page.getByRole("heading", { name: "Photoreal avatar" });
          await expect(h).toBeVisible();
          await h.evaluate((el) => el.scrollIntoView({ block: "start" }));
          await shot(page, "photoreal-settings-not-connected", vp.id, scheme);
          await req(baseURL!, api.token, "PUT", "/calls/avatar/connection", { provider: "did", api_key: `shot${stamp}user:${Math.random().toString(36).slice(2)}secret` });
          await req(baseURL!, api.token, "POST", "/calls/avatar/connection/test");
          const av = await req(baseURL!, api.token, "POST", "/calls/avatar/avatars", { name: "Amy", source: "presenter", presenter_id: "v2_public_amy", voice_provider: "microsoft", voice_id: "en-US-JennyNeural" });
          avatarId = av.id;
          await req(baseURL!, api.token, "PUT", `/agents/${agent.id}/photoreal-avatar`, { avatar_id: av.id });
          await req(baseURL!, api.token, "PATCH", "/calls/settings", { avatar: { enabled: true, minutes_daily: 15, max_concurrent: 5 } });
          await page.reload();
          await expect(page.getByText("Connected and on")).toBeVisible();
          await page.getByRole("heading", { name: "Photoreal avatar" }).evaluate((el) => el.scrollIntoView({ block: "start" }));
          await shot(page, "photoreal-settings-connected", vp.id, scheme);
          const site = await startCustomerSite(baseURL!);
          const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, permissions: ["microphone", "camera"] });
          await ctx.addInitScript(FAKE_MEDIA_SCRIPT);
          await ctx.addInitScript(FAKE_SPEECH_SCRIPT);
          const v = await ctx.newPage();
          await v.goto(site.url);
          await v.getByRole("button", { name: "Open chat" }).click();
          await v.getByLabel("Your name").fill(`Shot ${stamp}`);
          await v.getByLabel(/^Email/).fill(`shot.pr.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`);
          await v.getByRole("button", { name: "Start chat" }).click();
          await v.getByRole("button", { name: "Video call with our AI assistant (avatar)" }).click();
          await expect(v.getByRole("dialog", { name: /Call with Aria/ })).toContainText("switched to the simple avatar", { timeout: 20_000 });
          await shot(v, "photoreal-call-fallback", vp.id, scheme);
          await v.getByRole("button", { name: "End call" }).click().catch(() => {});
          await ctx.close();
          await site.close();
        } finally {
          if (avatarId) await req(baseURL!, api.token, "DELETE", `/calls/avatar/avatars/${avatarId}`).catch(() => {});
          await req(baseURL!, api.token, "DELETE", "/calls/avatar/connection").catch(() => {});
          await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { calls: { ai: { enabled: false }, avatar: { enabled: false } } } }).catch(() => {});
          await req(baseURL!, api.token, "DELETE", `/agents/${agent.id}`).catch(() => {});
        }
      });
    });
  }
}
