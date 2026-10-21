import { expect, freshVisitor, openRoom, signIn, stamp, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";

const log = (page: import("@playwright/test").Page) => page.getByRole("log", { name: "Conversation messages" });

// The demo workspace has no AI agent on (so other specs never get answers they did not set up): this spec switches one on, uses it, and switches it off again.
test("assign menu: give a waiting conversation to an AI agent, which answers the visitor's message", async ({ page, baseURL }) => {
  const owner = await loginApi(baseURL!);
  const agent = await owner.post("/agents", { name: `Aria ${stamp}`, enabled: true, autonomy: "auto_answer", persona: "You help customers of Demo Co." });
  try {
    const name = await freshVisitor(baseURL!, `Waiting Wendy ${stamp}`, ["How do I reset my password?"]);
    await signIn(page);
    await openRoom(page, name);
    const assign = page.getByRole("button", { name: "Assign conversation" });
    await assign.click();
    await expect(page.getByRole("menuitemcheckbox", { name: new RegExp(`Aria ${stamp}`) })).toBeVisible();
    await page.getByRole("menuitemcheckbox", { name: new RegExp(`Aria ${stamp}`) }).click();
    await expect(assign).toContainText(`Aria ${stamp} (AI)`);
    await expect(page.getByText(/AI agent/).first()).toBeVisible();
    // the agent answered the waiting question: an AI-labelled reply from it appears in the thread
    await expect(log(page).getByText(`Aria ${stamp}`).first()).toBeVisible({ timeout: 20_000 });
    await expect(log(page).getByText("Was this answer right?")).toBeVisible();
  } finally {
    await fetch(`${baseURL}/api/agents/${agent.id}`, { method: "PATCH", headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  }
});
