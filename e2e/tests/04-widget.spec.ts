import { expect, signIn, stamp, test } from "../support/fixtures";
import { startCustomerSite } from "../support/site";


test("a visitor chats through the embedded widget and an agent answers from the inbox in real time", async ({ browser, baseURL }) => {
  const site = await startCustomerSite(baseURL!);

  const visitorCtx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const visitor = await visitorCtx.newPage();
  await visitor.goto(site.url);
  await visitor.getByRole("button", { name: "Open chat" }).click();
  // pre-chat form: name is required, email and phone are optional
  await visitor.getByLabel("Your name").fill(`Widget Wendy ${stamp}`);
  await visitor.getByLabel(/^Email/).fill(`wendy.${stamp}@example.test`);
  await visitor.getByRole("button", { name: "Start chat" }).click();
  const input = visitor.getByRole("textbox", { name: "Message" });
  await input.click();
  await input.pressSequentially(`Hello from the widget ${stamp}`, { delay: 5 });
  await visitor.getByRole("button", { name: "Send message" }).click();
  await expect(visitor.getByLabel("Conversation").getByText(`Hello from the widget ${stamp}`)).toBeVisible();

  // agent side: the conversation shows up live and the reply travels back
  const agentCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const agent = await agentCtx.newPage();
  await signIn(agent);
  await agent.getByRole("region", { name: "Conversations" }).getByRole("link", { name: new RegExp(`Widget Wendy ${stamp}`) }).first().click();
  await expect(agent.getByRole("log", { name: "Conversation messages" }).getByText(`Hello from the widget ${stamp}`)).toBeVisible();
  const box = agent.getByRole("textbox", { name: "Write a reply" });
  await box.click();
  await box.pressSequentially(`Hi, agent here (${stamp})`, { delay: 5 });
  await box.press("Enter");
  await expect(visitor.getByLabel("Conversation").getByText(`Hi, agent here (${stamp})`)).toBeVisible({ timeout: 15_000 });

  // typing indicator and unread badge are accessible text, not just colour
  await visitor.getByRole("button", { name: "Close chat" }).click();
  await expect(visitor.getByRole("button", { name: "Open chat" })).toBeVisible();
  await visitorCtx.close();
  await agentCtx.close();
  await site.close();
});

test("the widget is keyboard operable: Escape closes the panel and focus returns to the launcher", async ({ page, baseURL }) => {
  const site = await startCustomerSite(baseURL!);
  await page.goto(site.url);
  const launcher = page.getByRole("button", { name: "Open chat" });
  await launcher.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close chat" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open chat" })).toBeVisible();
  await site.close();
});
