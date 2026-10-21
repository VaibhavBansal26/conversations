// Screenshot matrix for the screens added with team chat, channel connections, widget install and getting started
// (pages x 3 viewports x light/dark). Run with `npm run shots` (writes to ../docs/design, or SHOTS_DIR).
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { loginApi } from "../support/api.mjs";
import { DEMO, expect, openRoom, signIn, stamp, test } from "../support/fixtures";

const OUT = process.env.SHOTS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../docs/design");
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [
  { id: "1440x900", width: 1440, height: 900 },
  { id: "1024x768", width: 1024, height: 768 },
  { id: "390x844", width: 390, height: 844 },
] as const;
const SCHEMES = ["light", "dark"] as const;
const shot = async (page: Page, name: string, vp: string, scheme: string) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(OUT, `${name}-${vp}-${scheme}.jpg`), type: "jpeg", quality: 82 });
};

let channelId = "";
test.beforeAll(async ({ baseURL }) => {
  const owner = await loginApi(baseURL!);
  const sam = await loginApi(baseURL!, { email: "sam@example.test", password: DEMO.password });
  const maya = await loginApi(baseURL!, { email: "maya@example.test", password: DEMO.password });
  const members = (await owner.get("/members")).data as { id: string; name: string }[];
  const id = (n: string) => members.find((m) => m.name.startsWith(n))!.id;
  const ch = await owner.post("/team/channels", { name: `support-escalations-${stamp}`.slice(0, 32), topic: "Hard cases and who owns them", member_ids: [id("Sam"), id("Maya")] });
  channelId = ch.id;
  const say = async (who: typeof owner, content: string, extra: object = {}) => who.post(`/team/channels/${channelId}/messages`, { content, client_msg_id: crypto.randomUUID(), ...extra });
  await say(owner, "Morning all. Two escalations today: the refund for order 4412 and the broken label for Grace.");
  const root = await say(sam, "I can take Grace. Carrier says the label was voided, re-issuing now.");
  await say(maya, `Thanks @[Sam Agent](${id("Sam")}). Please add a note on the account when it is done.`);
  await say(sam, "Done, tracking number sent to her by email.", { thread_root_id: root.id });
  await owner.post(`/team/messages/${root.id}/reactions`, { emoji: "👍" });
  await maya.post(`/team/messages/${root.id}/reactions`, { emoji: "🎉" });
  await owner.post(`/team/messages/${root.id}/reactions`, { emoji: "🎉" });
  await say(owner, "Please remember: refunds over $200 need a second pair of eyes.");
  await sam.post("/team/dms", { member_ids: [id("Demo")] }).then((dm: { id: string }) => sam.post(`/team/channels/${dm.id}/messages`, { content: "Got a minute to look at Frank's thread?", client_msg_id: crypto.randomUUID() }));
});

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`team screens ${vp.id} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.width < 600, isMobile: vp.width < 600 });

      test("team chat: list, channel, thread", async ({ page }) => {
        await signIn(page);
        await page.goto("/team");
        await expect(page.getByRole("navigation", { name: "Team chat" })).toBeVisible();
        await shot(page, "team-list", vp.id, scheme);
        await page.goto(`/team/${channelId}`);
        await expect(page.getByRole("log").getByText(/I can take Grace/)).toBeVisible();
        await shot(page, "team-channel", vp.id, scheme);
        await page.getByRole("button", { name: /1 reply/ }).click();
        await expect(page.getByRole("region", { name: "Thread" })).toBeVisible();
        await shot(page, "team-thread", vp.id, scheme);
      });

      test("channel settings: test mode and the connect cards", async ({ page }) => {
        await signIn(page);
        await page.goto("/settings/channels");
        await expect(page.getByRole("form", { name: "Connect Twilio" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "settings-channels", vp.id, scheme);
      });

      test("widget install", async ({ page }) => {
        await signIn(page);
        await page.goto("/settings/widget?tab=install");
        await expect(page.getByRole("heading", { name: "Install the chat widget" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await shot(page, "widget-install", vp.id, scheme);
      });

      test("inbox with the getting started card, and an SMS in test mode", async ({ page }) => {
        await signIn(page);
        await expect(page.getByTestId("getting-started")).toBeVisible();
        await shot(page, "inbox-getting-started", vp.id, scheme);
        await openRoom(page, "Alice Johnson");
        await page.getByRole("tab", { name: "SMS" }).click();
        await expect(page.getByTestId("channel-banner-sms")).toBeVisible();
        const box = page.getByRole("textbox", { name: /write a reply/i });
        await box.fill(`Your order shipped today (${stamp})`);
        await box.press("Enter");
        await expect(page.getByText("Test mode: not sent").last()).toBeVisible();
        await shot(page, "conversation-test-mode", vp.id, scheme);
      });
    });
  }
}
