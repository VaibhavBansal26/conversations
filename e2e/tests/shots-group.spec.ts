// Screenshot matrix for group calls (screens x 3 viewports x light/dark). Run with `npx playwright test tests/shots-group.spec.ts --project=shots`.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { loginApi } from "../support/api.mjs";
import { FAKE_MEDIA_SCRIPT } from "../support/fakeMedia";
import { DEMO, expect, signIn, test } from "../support/fixtures";

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design");
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [{ id: "1440x900", width: 1440, height: 900 }, { id: "1024x768", width: 1024, height: 768 }, { id: "390x844", width: 390, height: 844 }] as const;
const SCHEMES = ["light", "dark"] as const;
const shot = async (page: Page, name: string, vp: string, scheme: string) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}-${vp}-${scheme}.jpg`), type: "jpeg", quality: 82 });
};
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`group calls ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600, permissions: ["microphone", "camera"] });
      test("settings, the picker, ringing and the call", async ({ browser, baseURL }) => {
        test.setTimeout(120_000);
        const owner = await loginApi(baseURL!);
        await req(baseURL!, owner.token, "PATCH", "/calls/settings", { internal: { enabled: true, voice: true, video: true, screen_share: true, ring_seconds: 60, group: true, group_max: 4 } });
        const members = (await req(baseURL!, owner.token, "GET", "/members")).data as { id: string; email: string }[];
        const ids = ["sam", "priya"].map((n) => members.find((m) => m.email === `${n}@example.test`)!.id);
        const group = await req(baseURL!, owner.token, "POST", "/team/dms", { member_ids: ids });
        const ctxs = await Promise.all([1, 2, 3].map(() => browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, permissions: ["microphone", "camera"] })));
        for (const c of ctxs) await c.addInitScript(FAKE_MEDIA_SCRIPT);
        const [op, sp, pp] = await Promise.all(ctxs.map((c) => c.newPage()));
        try {
          await signIn(op!);
          await signIn(sp!, { email: "sam@example.test", password: DEMO.password });
          await signIn(pp!, { email: "priya@example.test", password: DEMO.password });
          await op!.goto("/settings/calls");
          await expect(op!.getByRole("switch", { name: /Group calls/ })).toBeVisible();
          await op!.getByRole("switch", { name: /Group calls/ }).scrollIntoViewIfNeeded();
          await shot(op!, "group-call-settings", vp.id, scheme);
          await op!.goto(`/team/${group.id}`);
          await op!.getByRole("button", { name: "Start a group video call" }).click();
          await expect(op!.getByRole("dialog", { name: "Start a group video call" })).toBeVisible();
          await shot(op!, "group-call-picker", vp.id, scheme);
          await op!.getByRole("button", { name: "Start the call" }).click();
          await expect(sp!.getByRole("alertdialog", { name: "Incoming group call" })).toBeVisible();
          await shot(sp!, "group-call-incoming", vp.id, scheme);
          await sp!.getByRole("button", { name: /^Join the group call/ }).click();
          await pp!.getByRole("button", { name: /^Join the group call/ }).click();
          await expect(op!.getByText("3 of 4")).toBeVisible();
          await op!.waitForTimeout(2500);
          await shot(op!, "group-call-active", vp.id, scheme);
          await sp!.getByRole("button", { name: "Share your screen" }).click();
          await expect(op!.getByRole("listitem", { name: /sharing their screen/ })).toBeVisible();
          await op!.waitForTimeout(1500);
          await shot(op!, "group-call-screen-share", vp.id, scheme);
          for (const p of [op!, sp!, pp!]) await p.getByRole("button", { name: "Leave the call" }).click();
        } finally {
          await req(baseURL!, owner.token, "PATCH", "/calls/settings", { internal: { enabled: false } }).catch(() => {});
          for (const c of ctxs) await c.close();
        }
      });
    });
  }
}
