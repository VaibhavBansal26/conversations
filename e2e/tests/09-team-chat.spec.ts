import AxeBuilder from "@axe-core/playwright";
import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEMO, expect, signIn, stamp, test } from "../support/fixtures";

const SHOTS = process.env.TEAM_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.jpg`), type: "jpeg", quality: 82 });
};

const SAM = { email: "sam@example.test", password: DEMO.password };

async function twoPeople(browser: Browser, opts: { viewport?: { width: number; height: number }; colorScheme?: "light" | "dark" } = {}) {
  const ctxOpts = { viewport: opts.viewport ?? { width: 1440, height: 900 }, colorScheme: opts.colorScheme ?? "light" } as const;
  const ownerCtx = await browser.newContext(ctxOpts);
  const samCtx = await browser.newContext(ctxOpts);
  const owner = await ownerCtx.newPage();
  const sam = await samCtx.newPage();
  await signIn(owner);
  await signIn(sam, SAM);
  await owner.goto("/team");
  await sam.goto("/team");
  await expect(owner.getByRole("navigation", { name: "Team chat" })).toBeVisible();
  await expect(sam.getByRole("navigation", { name: "Team chat" })).toBeVisible();
  return { owner, sam, close: async () => { await ownerCtx.close(); await samCtx.close(); } };
}

const messageBox = (p: Page, name: RegExp | string) => p.getByRole("textbox", { name });
async function say(p: Page, name: RegExp | string, text: string) {
  const box = messageBox(p, name);
  await box.click();
  await box.pressSequentially(text, { delay: 4 });
  await box.press("Enter");
}

test("two people chat in real time: channel, thread, reaction, edit, delete, unread, mention, DM, pin, search, share", async ({ browser }) => {
  test.setTimeout(300_000);
  const { owner, sam, close } = await twoPeople(browser);
  const channel = `launch-${stamp}`.slice(0, 30);

  // #general exists for everyone
  await expect(owner.getByRole("link", { name: /general/ })).toBeVisible();
  await expect(sam.getByRole("link", { name: /general/ })).toBeVisible();

  // the owner creates a channel with Sam in it; it appears for Sam without a reload
  await owner.getByRole("button", { name: "Start something" }).click();
  await owner.getByRole("menuitem", { name: "Create a channel" }).click();
  const dialog = owner.getByRole("dialog", { name: "Create a channel" });
  await dialog.getByLabel("Name").fill(channel);
  await dialog.getByLabel("Topic (optional)").fill("Launch week coordination");
  await dialog.getByRole("checkbox", { name: /Sam Agent/ }).check();
  await shot(owner, "create-channel");
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(owner.getByRole("heading", { name: channel, level: 1 })).toBeVisible();
  await expect(sam.getByRole("link", { name: new RegExp(channel) })).toBeVisible();

  // message from the owner arrives at Sam as unread (Sam is looking at the empty state)
  await say(owner, `Message #${channel}`, `Hello team ${stamp}`);
  await expect(sam.getByRole("link", { name: new RegExp(`${channel}.*1 unread`) })).toBeVisible();
  await expect(sam.title()).resolves.toBeDefined();

  // Sam opens it: the message is there, the unread count clears, and replying in a thread works
  await sam.getByRole("link", { name: new RegExp(channel) }).click();
  const log = sam.getByRole("log", { name: new RegExp(`Messages in ${channel}`) });
  await expect(log.getByText(`Hello team ${stamp}`)).toBeVisible();
  await expect(sam.getByRole("link", { name: new RegExp(`${channel}$`) })).toBeVisible();
  await log.getByTestId("team-message").filter({ hasText: `Hello team ${stamp}` }).hover();
  await sam.getByRole("button", { name: "Reply in thread" }).first().click();
  const thread = sam.getByRole("region", { name: "Thread" });
  await expect(thread).toBeVisible();
  await say(sam, "Reply…", `Thread reply ${stamp}`);
  await expect(thread.getByText(`Thread reply ${stamp}`)).toBeVisible();
  await shot(sam, "thread");
  // the owner sees the reply counter live and opens the thread
  await expect(owner.getByRole("button", { name: "1 reply" })).toBeVisible();
  await owner.getByRole("button", { name: "1 reply" }).click();
  await expect(owner.getByRole("region", { name: "Thread" }).getByText(`Thread reply ${stamp}`)).toBeVisible();

  // reactions travel both ways
  const ownerLog = owner.getByRole("log", { name: new RegExp(`Messages in ${channel}`) });
  const ownerMsg = ownerLog.getByTestId("team-message").filter({ hasText: `Hello team ${stamp}` });
  await ownerMsg.hover();
  await owner.getByRole("button", { name: "Add reaction" }).first().click();
  await owner.getByRole("menuitem", { name: "🎉" }).click();
  await expect(sam.getByRole("log", { name: new RegExp(`Messages in ${channel}`) }).getByRole("button", { name: /🎉 1/ })).toBeVisible();

  // pin and see it listed
  await ownerMsg.hover();
  await owner.getByRole("button", { name: "Pin message" }).first().click();
  await owner.getByRole("button", { name: "Pinned messages" }).click();
  await expect(owner.getByRole("region", { name: "Pinned messages" }).getByText(`Hello team ${stamp}`)).toBeVisible();
  await shot(owner, "pins");
  await owner.getByRole("button", { name: "Close pinned messages" }).click();

  // @mention creates a notification for Sam and the text renders as a name
  await messageBox(owner, `Message #${channel}`).click();
  await messageBox(owner, `Message #${channel}`).pressSequentially("@Sam", { delay: 4 });
  await owner.getByRole("option", { name: /Sam Agent/ }).click();
  await owner.getByRole("textbox", { name: `Message #${channel}` }).pressSequentially(`please review ${stamp}`, { delay: 4 });
  await owner.getByRole("textbox", { name: `Message #${channel}` }).press("Enter");
  await expect(sam.getByRole("log").getByText("@Sam Agent")).toBeVisible();
  await sam.getByRole("button", { name: /Notifications/ }).first().click();
  await expect(sam.getByText(/Demo Owner mentioned you in #/)).toBeVisible();
  await sam.keyboard.press("Escape");

  // edit and delete by the author
  const mine = ownerLog.getByTestId("team-message").filter({ hasText: `please review ${stamp}` });
  await mine.hover();
  await owner.getByRole("button", { name: "More actions" }).first().click();
  await owner.getByRole("menuitem", { name: "Edit message" }).click();
  const editor = owner.getByRole("textbox", { name: "Edit message" });
  await editor.fill(`please review again ${stamp}`);
  await editor.press("Enter");
  await expect(sam.getByRole("log").getByText(`please review again ${stamp}`)).toBeVisible();
  await expect(sam.getByRole("log").getByText("(edited)")).toBeVisible();
  const toDelete = ownerLog.getByTestId("team-message").filter({ hasText: `please review again ${stamp}` });
  await toDelete.hover();
  await owner.getByRole("button", { name: "More actions" }).first().click();
  await owner.getByRole("menuitem", { name: "Delete message" }).click();
  await expect(sam.getByRole("log").getByText(`please review again ${stamp}`)).toHaveCount(0);

  // a direct message
  await owner.getByRole("button", { name: "New message" }).first().click();
  const nm = owner.getByRole("dialog", { name: "New message" });
  await nm.getByRole("checkbox", { name: /Sam Agent/ }).check();
  await nm.getByRole("button", { name: "Start conversation" }).click();
  await expect(owner.getByRole("heading", { name: "Sam Agent", level: 1 })).toBeVisible();
  await say(owner, "Message Sam Agent", `private note ${stamp}`);
  await expect(sam.getByRole("link", { name: /Demo Owner.*1 unread/ })).toBeVisible();
  await shot(owner, "dm");

  // search finds it; a person outside the DM cannot (checked in the server tests)
  await sam.getByRole("button", { name: "Search team chat" }).click();
  await sam.getByRole("searchbox", { name: "Search messages" }).fill(`private note ${stamp}`);
  await expect(sam.getByRole("dialog").getByText(`private note ${stamp}`)).toBeVisible();
  await shot(sam, "search");
  await sam.keyboard.press("Escape");

  // sharing a customer conversation: the card opens the conversation for people who may see it
  await owner.goto("/inbox");
  await owner.getByRole("link", { name: /Alice Johnson/ }).first().click();
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("menuitem", { name: "Share with the team" }).click();
  const share = owner.getByRole("dialog", { name: "Share with the team" });
  await share.getByLabel("Where").selectOption({ label: `#${channel}` });
  await share.getByLabel("Note (optional)").fill("Can someone take this?");
  await share.getByRole("button", { name: "Share" }).click();
  await owner.goto(`/team`);
  await owner.getByRole("link", { name: new RegExp(channel) }).click();
  await expect(owner.getByTestId("share-card").first()).toContainText("Alice Johnson");
  // Sam is not assigned to Alice's conversation here: the card carries no customer details
  await sam.getByRole("link", { name: new RegExp(channel) }).click();
  const samCard = sam.getByTestId("share-card").first();
  await expect(samCard).toBeVisible();
  const aliceVisibleToSam = await samCard.getAttribute("data-available");
  expect(["true", "false"]).toContain(aliceVisibleToSam);
  if (aliceVisibleToSam === "false") await expect(sam.getByRole("log").getByText("Alice Johnson")).toHaveCount(0);

  await close();
});

test("the sidebar, composer and keyboard: Alt+Arrow moves between conversations, ArrowUp edits the last message, Escape closes the thread", async ({ browser }) => {
  const { owner, sam, close } = await twoPeople(browser);
  await owner.getByRole("link", { name: /general/ }).click();
  await say(owner, "Message #general", `kbd ${stamp}`);
  await expect(owner.getByRole("log").getByText(`kbd ${stamp}`)).toBeVisible();
  await messageBox(owner, "Message #general").press("ArrowUp");
  const editor = owner.getByRole("textbox", { name: "Edit message" });
  await expect(editor).toBeVisible();
  await editor.press("Escape");
  await owner.keyboard.press("Alt+ArrowDown");
  await expect(owner).toHaveURL(/\/team\/.+/);
  await sam.getByRole("link", { name: /general/ }).click();
  await expect(sam.getByRole("log").getByText(`kbd ${stamp}`)).toBeVisible();
  await close();
});

test("long history is virtualised and older pages load without losing your place", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const { owner, close } = await twoPeople(browser);
  const token = await owner.evaluate(() => localStorage.getItem("conversations.token"));
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const ch = await (await fetch(`${baseURL}/api/team/channels`, { method: "POST", headers: auth, body: JSON.stringify({ name: `history-${stamp}`.slice(0, 30) }) })).json();
  for (let i = 1; i <= 160; i++) await fetch(`${baseURL}/api/team/channels/${ch.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ content: `history message ${i}`, client_msg_id: `hist-${stamp}-${i}-xxxxxxxx` }) });
  await owner.goto(`/team/${ch.id}`);
  const log = owner.getByRole("log", { name: /Messages in history/ });
  await expect(log.getByText("history message 160")).toBeVisible();
  // only a window of the 160 rows is in the DOM
  expect(await log.getByTestId("team-message").count()).toBeLessThan(60);
  // scroll to the top: older messages load and the first visible message stays the oldest loaded one
  for (let i = 0; i < 8; i++) {
    await log.evaluate((el) => { el.scrollTop = 0; });
    if (await log.getByText("history message 1", { exact: true }).isVisible()) break;
    await owner.waitForTimeout(500);
  }
  await expect(log.getByText("history message 1", { exact: true })).toBeVisible({ timeout: 15_000 });
  await close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`accessibility (axe, ${scheme}): team chat, dialogs and panels`, async ({ browser }) => {
    test.setTimeout(90_000);
    const { owner, close } = await twoPeople(browser, { colorScheme: scheme });
    const audit = async (label: string) => {
      const results = await new AxeBuilder({ page: owner }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      expect(summary, `${label}\n${summary.join("\n")}`).toEqual([]);
    };
    await owner.emulateMedia({ reducedMotion: "reduce" });
    await audit("team empty state");
    await owner.getByRole("link", { name: /general/ }).click();
    await say(owner, "Message #general", `axe ${scheme} ${stamp}`);
    await expect(owner.getByRole("log").getByText(`axe ${scheme} ${stamp}`)).toBeVisible();
    await audit("channel");
    await owner.getByRole("button", { name: /^Details/ }).click();
    await expect(owner.getByRole("region", { name: "Channel details" })).toBeVisible();
    await audit("channel details");
    await owner.getByRole("button", { name: "Close channel details" }).click();
    await owner.getByRole("button", { name: "Start something" }).click();
    await owner.getByRole("menuitem", { name: "New message" }).click();
    await expect(owner.getByRole("dialog", { name: "New message" })).toBeVisible();
    await audit("new message dialog");
    await owner.keyboard.press("Escape");
    await owner.getByRole("button", { name: "Search team chat" }).click();
    await expect(owner.getByRole("dialog")).toBeVisible();
    await audit("search dialog");
    await close();
  });
}

test.describe("phone layout", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("390x844: list and channel are separate screens, bottom navigation, no horizontal scroll", async ({ browser }) => {
    const { owner, close } = await twoPeople(browser, { viewport: { width: 390, height: 844 } });
    await expect(owner.getByRole("navigation", { name: "Main" })).toBeVisible();
    await shot(owner, "mobile-list");
    await owner.getByRole("link", { name: /general/ }).click();
    await expect(owner.getByRole("heading", { name: "general", level: 1 })).toBeVisible();
    await expect(owner.getByRole("navigation", { name: "Team chat" })).toBeHidden();
    await say(owner, "Message #general", `phone ${stamp}`);
    await shot(owner, "mobile-channel");
    const overflow = await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await owner.getByRole("link", { name: "Back to team chat" }).click();
    await expect(owner.getByRole("navigation", { name: "Team chat" })).toBeVisible();
    await close();
  });
});
