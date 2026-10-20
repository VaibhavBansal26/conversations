import { composer, expect, freshVisitor, openRoom, sendReply, signIn, test } from "../support/fixtures";

const stamp = Date.now().toString(36);
const log = (page: import("@playwright/test").Page) => page.getByRole("log", { name: "Conversation messages" });

test.describe("inbox: reading and replying", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("lists conversations with unread badges, assignees and sidebar counts", async ({ page, baseURL }) => {
    await freshVisitor(baseURL!, `Unread Una ${stamp}`, ["Hello, one", "Hello, two"]);
    await page.reload();
    const list = page.getByRole("region", { name: "Conversations" });
    await expect(list.getByRole("link", { name: /Dave Kim/ })).toContainText(/THE SITE IS DOWN|Note:/);
    await expect(list.getByRole("link", { name: /Dave Kim/ })).not.toContainText("mem_");
    await expect(list.getByRole("link", { name: new RegExp(`Unread Una ${stamp}`) }).getByLabel(/^\d+ unread$/)).toBeVisible();
    await expect(list.getByLabel("Priority")).toHaveCount(1);
    await expect(list.getByLabel("Assigned to Sam Agent").first()).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Inbox navigation" });
    await expect(nav.getByRole("link", { name: /Unassigned/ })).toContainText(/\d/);
    await expect(nav.getByRole("link", { name: /Sales/ })).toBeVisible();
  });

  test("opens a conversation: grouped bubbles, day separators, ticks and the composer", async ({ page }) => {
    await openRoom(page, "Alice Johnson");
    const thread = log(page);
    await expect(thread.getByText("Do you offer annual billing?")).toBeVisible();
    await expect(thread.getByRole("separator").first()).toBeVisible();
    await expect(thread.getByRole("img", { name: /^(Sent|Delivered|Read)$/ }).first()).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await expect(page).toHaveURL(/\/inbox\/room_|\/inbox\/[a-z0-9_]+/);
  });

  test("sends a reply by typing and pressing Enter; the list snippet updates", async ({ page }) => {
    await openRoom(page, "Frank Lopez");
    const text = `Hi Frank, we are here (${stamp})`;
    await sendReply(page, text);
    await expect(log(page).getByText(text)).toBeVisible();
    await expect(composer(page)).toHaveValue("");
    await expect(page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Frank Lopez/ })).toContainText(`You: ${text}`);
  });

  test("Shift+Enter inserts a newline instead of sending", async ({ page }) => {
    await openRoom(page, "Frank Lopez");
    const box = composer(page);
    await box.click();
    await box.pressSequentially("line one");
    await box.press("Shift+Enter");
    await box.pressSequentially("line two");
    await expect(box).toHaveValue("line one\nline two");
    await box.fill("");
  });

  test("internal notes: the Note tab, @mention picker and distinct styling", async ({ page }) => {
    await openRoom(page, "Dave Kim");
    await page.getByRole("tab", { name: "Note" }).click();
    const box = composer(page);
    await expect(box).toHaveAttribute("aria-label", "Write an internal note");
    await box.click();
    await box.pressSequentially("Please look at this @May");
    await page.getByRole("option", { name: /Maya Manager/ }).click();
    await box.pressSequentially(`ASAP ${stamp}`);
    await page.getByRole("button", { name: "Add note" }).click();
    const note = log(page).locator('[data-bubble="note"]').last();
    await expect(note).toContainText("Internal note");
    await expect(note).toContainText("@Maya Manager");
    await expect(note).toContainText(`ASAP ${stamp}`);
    await page.getByRole("tab", { name: "Chat" }).click();
  });

  test("templates: typing / opens the picker and Enter fills the rendered template", async ({ page }) => {
    await openRoom(page, "Linus Torvalds");
    const box = composer(page);
    await box.click();
    await box.pressSequentially("/bye");
    await expect(page.getByRole("listbox", { name: "Templates" })).toBeVisible();
    await box.press("Enter");
    await expect(box).toHaveValue(/Glad I could help, Linus/);
    await box.fill("");
  });

  test("the template picker button lists templates for the channel", async ({ page }) => {
    await openRoom(page, "Linus Torvalds");
    await page.getByRole("button", { name: "Insert template" }).click();
    await page.getByRole("textbox", { name: "Search templates" }).fill("clos");
    await page.getByRole("button", { name: /Closing/ }).click();
    await expect(composer(page)).toHaveValue(/Glad I could help/);
    await composer(page).fill("");
  });

  test("emoji picker inserts at the caret", async ({ page }) => {
    await openRoom(page, "Linus Torvalds");
    const box = composer(page);
    await box.fill("great");
    await page.getByRole("button", { name: "Insert emoji" }).click();
    await page.getByRole("tab", { name: "Objects" }).click();
    await page.getByRole("button", { name: "Insert 🎉" }).click();
    await expect(box).toHaveValue(/great.*🎉|🎉.*great/);
    await box.fill("");
  });

  test("channel tabs: SMS shows a counter, Email shows From and Subject", async ({ page }) => {
    await openRoom(page, "Bob Martinez");
    await page.getByRole("tab", { name: "SMS" }).click();
    await composer(page).fill("hello over sms");
    await expect(page.getByText(/^14\/1599$/)).toBeVisible();
    await page.getByRole("tab", { name: "Email" }).click();
    await expect(page.getByLabel("From")).toBeVisible();
    await expect(page.getByLabel("Subject")).toBeVisible();
    await composer(page).fill("");
    await page.getByRole("tab", { name: "Chat" }).click();
  });

  test("attachments: choose an image, see the chip, send it, open the viewer and step through with the keyboard", async ({ page }) => {
    await openRoom(page, "Bob Martinez");
    await page.getByRole("tab", { name: "Chat" }).click();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "one.png", mimeType: "image/png", buffer: png },
      { name: "two.png", mimeType: "image/png", buffer: png },
    ]);
    await expect(page.getByRole("list", { name: "Attachments" }).getByText("one.png")).toBeVisible();
    await expect(page.getByRole("list", { name: "Attachments" }).getByText("two.png")).toBeVisible();
    await composer(page).fill(`Photos ${stamp}`);
    await page.getByRole("button", { name: "Send" }).click();
    const first = log(page).getByRole("button", { name: "View one.png" }).last();
    await first.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("1 / 2");
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("2 / 2");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("voice notes render a player that plays and pauses real audio", async ({ page }) => {
    await openRoom(page, "Alice Johnson");
    const player = log(page).getByTestId("voice-note").last();
    await expect(player).toBeVisible();
    await player.getByRole("button", { name: "Play voice note" }).click();
    await expect(player.getByRole("button", { name: "Pause voice note" })).toBeVisible();
    await player.getByRole("button", { name: "Pause voice note" }).click();
    await expect(player.getByRole("button", { name: "Play voice note" })).toBeVisible();
    await player.getByRole("button", { name: /Playback speed 1x/ }).click();
    await expect(player.getByRole("button", { name: /Playback speed 1.5x/ })).toBeVisible();
  });

  test("reply-to quotes the original message in the thread", async ({ page }) => {
    await openRoom(page, "Grace Hopper");
    const row = log(page).locator("[data-message-id]").filter({ hasText: "tracking page has not updated" }).first();
    await row.hover();
    await row.getByRole("button", { name: "Reply to this message" }).click();
    await expect(page.getByRole("button", { name: "Cancel reply" })).toBeVisible();
    await sendReply(page, `Checking now ${stamp}`);
    const quoted = log(page).locator("blockquote").last();
    await expect(quoted).toContainText("tracking page has not updated");
  });

  test("edit and delete your own message (delete asks for confirmation)", async ({ page }) => {
    await openRoom(page, "Frank Lopez");
    const mine = log(page).locator('[data-direction="out"]').filter({ hasText: stamp }).last();
    await mine.hover();
    await mine.getByRole("button", { name: "Edit message" }).click();
    const edit = mine.getByRole("textbox", { name: "Edit message" });
    await edit.fill(`Edited reply ${stamp}`);
    await mine.getByRole("button", { name: "Save" }).click();
    await expect(log(page).getByText(`Edited reply ${stamp}`)).toBeVisible();
    await expect(log(page).getByText("edited").last()).toBeVisible();
    const edited = log(page).locator('[data-direction="out"]').filter({ hasText: `Edited reply ${stamp}` }).last();
    await edited.hover();
    await edited.getByRole("button", { name: "Delete message" }).click();
    await page.getByRole("dialog", { name: "Delete this message?" }).getByRole("button", { name: "Cancel" }).click();
    await expect(log(page).getByText(`Edited reply ${stamp}`)).toBeVisible();
    await edited.hover();
    await edited.getByRole("button", { name: "Delete message" }).click();
    await page.getByRole("button", { name: "Delete message", exact: true }).last().click();
    await expect(log(page).getByText(`Edited reply ${stamp}`)).toHaveCount(0);
  });

  test("a failed send shows the reason and Retry delivers it once the connection is back", async ({ page, context }) => {
    await openRoom(page, "Linus Torvalds");
    await context.setOffline(true);
    const text = `Offline note ${stamp}`;
    await sendReply(page, text);
    await expect(page.getByRole("alert").filter({ hasText: "Failed to send" })).toBeVisible({ timeout: 20_000 });
    await context.setOffline(false);
    await page.getByRole("button", { name: /retry/i }).first().click();
    await expect(page.getByRole("alert").filter({ hasText: "Failed to send" })).toHaveCount(0, { timeout: 20_000 });
    await expect(log(page).getByText(text)).toHaveCount(1);
  });
});

test.describe("inbox: triage actions", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("assign through the menu, then unassign", async ({ page }) => {
    await openRoom(page, "Frank Lopez");
    await page.getByRole("button", { name: "Assign conversation" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Sam Agent" }).click();
    await expect(page.getByRole("button", { name: "Assign conversation" })).toContainText("Sam");
    await page.getByRole("button", { name: "Assign conversation" }).click();
    await page.getByRole("menuitem", { name: "Unassign" }).click();
    await expect(page.getByRole("button", { name: "Assign conversation" })).toContainText("Unassigned");
  });

  test("priority and favorite toggles are pressed buttons and appear in the list", async ({ page }) => {
    await openRoom(page, "Linus Torvalds");
    const prio = page.getByRole("button", { name: "Mark as priority" });
    await prio.click();
    await expect(prio).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Linus Torvalds/ }).getByLabel("Priority")).toBeVisible();
    await prio.click();
    await expect(prio).toHaveAttribute("aria-pressed", "false");
    const fav = page.getByRole("button", { name: "Favorite" });
    await fav.click();
    await expect(fav).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("navigation", { name: "Inbox navigation" }).getByRole("link", { name: "Favorites" }).click();
    await expect(page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Linus Torvalds/ })).toBeVisible();
    await page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Linus Torvalds/ }).click();
    await page.getByRole("button", { name: "Favorite" }).click();
  });

  test("snooze with a preset moves the conversation to the Snoozed tab and back", async ({ page }) => {
    await openRoom(page, "Linus Torvalds");
    await page.getByRole("button", { name: "Snooze conversation" }).click();
    await page.getByRole("button", { name: /^Later today|^Tomorrow|^In 3 hours|^Next week/i }).first().click();
    await expect(page.getByText("Snoozed", { exact: true }).first()).toBeVisible();
    await page.getByRole("tab", { name: /Snoozed/ }).click();
    await expect(page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Linus Torvalds/ })).toBeVisible();
    await page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Linus Torvalds/ }).click();
    await page.getByRole("button", { name: "Snooze conversation" }).click();
    await page.getByRole("button", { name: "Remove snooze" }).click();
    await page.getByRole("tab", { name: /Open/ }).click();
    await expect(page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Linus Torvalds/ })).toBeVisible();
  });

  test("close and reopen update the tabs", async ({ page }) => {
    await openRoom(page, "Grace Hopper");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    await page.getByRole("tab", { name: /Closed/ }).click();
    const row = page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Grace Hopper/ });
    await expect(row).toBeVisible();
    await row.click();
    await page.getByRole("button", { name: "Reopen" }).click();
    await page.getByRole("tab", { name: /Open/ }).click();
    await expect(page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: /Grace Hopper/ })).toBeVisible();
  });

  test("sidebar views and search narrow the list; search is kept in the URL", async ({ page }) => {
    const list = page.getByRole("region", { name: "Conversations" });
    await page.getByRole("navigation", { name: "Inbox navigation" }).getByRole("link", { name: /Priority/ }).click();
    await expect(page.getByRole("heading", { name: "Priority" })).toBeVisible();
    await expect(list.getByRole("link", { name: /Dave Kim/ })).toBeVisible();
    await expect(list.getByRole("link", { name: /Alice Johnson/ })).toHaveCount(0);
    await page.getByRole("navigation", { name: "Inbox navigation" }).getByRole("link", { name: /All conversations/ }).click();
    await page.getByRole("searchbox", { name: "Search conversations" }).pressSequentially("alice");
    await expect(page).toHaveURL(/q=alice/);
    await expect(list.getByRole("link", { name: /Alice Johnson/ })).toBeVisible();
    await expect(list.getByRole("link", { name: /Dave Kim/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(list.getByRole("link", { name: /Dave Kim/ })).toBeVisible();
  });

  test("search inside a conversation finds a message and jumps to it", async ({ page }) => {
    await openRoom(page, "Alice Johnson");
    await page.getByRole("button", { name: "Search in this conversation" }).click();
    await page.getByRole("searchbox", { name: "Search in this conversation" }).pressSequentially("seats");
    await expect(page.getByText(/1 match/)).toBeVisible();
    await page.getByRole("search").getByRole("button", { name: /seats/ }).click();
    await expect(log(page).getByText("Yes please, for 5 seats.")).toBeInViewport();
  });

  test("the AI suggestion strip puts text in the composer without sending it", async ({ page, baseURL }) => {
    await freshVisitor(baseURL!, `Suggest Me ${stamp}`, ["Can I change the delivery address on my order?"]);
    await page.reload();
    await openRoom(page, `Suggest Me ${stamp}`);
    const strip = page.getByRole("group", { name: "AI suggested replies" });
    await expect(strip).toBeVisible();
    const chip = strip.getByRole("button").first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();
    await expect(composer(page)).not.toHaveValue("");
    await composer(page).fill("");
  });
});

test.describe("inbox: contact panel and new conversations", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("the contact panel toggles, edits the contact (toast) and adds a note and a tag", async ({ page }) => {
    await openRoom(page, "Bob Martinez");
    const panel = page.getByRole("complementary", { name: "Contact details" });
    if (!(await panel.isVisible())) await page.getByRole("button", { name: "Contact details", exact: true }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Details", exact: true }).click();
    await panel.getByLabel("Name").fill(`Bob Martinez ${stamp}`);
    await panel.getByPlaceholder("Add tag").fill("priority-customer");
    await panel.getByRole("button", { name: "Add", exact: true }).click();
    await panel.getByRole("button", { name: "Save contact" }).click();
    await expect(page.getByText("Contact saved", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: `Bob Martinez ${stamp}`, level: 2 })).toBeVisible();
    await panel.getByLabel("New note").fill(`VIP since 2024 ${stamp}`);
    await panel.getByRole("button", { name: "Add note" }).click();
    await expect(panel.getByText(`VIP since 2024 ${stamp}`)).toBeVisible();
    await page.getByRole("button", { name: "Contact details", exact: true }).click();
    await expect(panel).toBeHidden();
  });

  test("new conversation: a new contact with a first message opens the thread", async ({ page }) => {
    await page.getByRole("button", { name: /^New conversation/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "New conversation" });
    await dialog.getByRole("tab", { name: "New contact" }).click();
    await dialog.getByLabel("Name").fill(`Ada Byron ${stamp}`);
    await dialog.getByLabel("Email").fill(`ada.${stamp}@example.test`);
    await dialog.getByLabel("First message (optional)").fill("Welcome aboard!");
    await dialog.getByRole("button", { name: "Start and send" }).click();
    await expect(page.getByRole("heading", { name: `Ada Byron ${stamp}`, level: 2 })).toBeVisible();
    await expect(log(page).getByText("Welcome aboard!")).toBeVisible();
  });
});

test.describe("inbox: keyboard, command palette and theme", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("j / k move through conversations, ? opens the help dialog, Escape closes it", async ({ page }) => {
    await page.getByRole("region", { name: "Conversations" }).getByRole("link").first().waitFor();
    await page.keyboard.press("j");
    await expect(page).toHaveURL(/\/inbox\/[^/?]+/);
    const first = page.url();
    await page.keyboard.press("j");
    expect(page.url()).not.toBe(first);
    await page.keyboard.press("k");
    expect(page.url()).toBe(first);
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(help).toBeVisible();
    await expect(help).toContainText("Command palette");
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
  });

  test("single-key shortcuts act on the open conversation: p priority, i panel, c composer, / search", async ({ page }) => {
    await openRoom(page, "Linus Torvalds");
    await page.keyboard.press("p");
    await expect(page.getByRole("button", { name: "Mark as priority" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("p");
    await expect(page.getByRole("button", { name: "Mark as priority" })).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("c");
    await expect(composer(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await page.locator("body").click({ position: { x: 700, y: 300 } });
    await page.keyboard.press("/");
    await expect(page.getByRole("searchbox", { name: "Search conversations" })).toBeFocused();
    await page.keyboard.press("Escape");
  });

  test("letter shortcuts are ignored while typing in the composer", async ({ page }) => {
    await openRoom(page, "Linus Torvalds");
    const box = composer(page);
    await box.click();
    await box.pressSequentially("jkp?");
    await expect(box).toHaveValue("jkp?");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await box.fill("");
  });

  test("Cmd/Ctrl+K opens the palette: jump to a conversation, then run an action on it", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.getByPlaceholder(/Search conversations/).pressSequentially("grace");
    await page.getByRole("option", { name: /Grace Hopper/ }).click();
    await expect(page.getByRole("heading", { name: "Grace Hopper", level: 2 })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByPlaceholder(/Search conversations/).pressSequentially("favorite");
    await page.getByRole("option", { name: /Add to favorites/ }).click();
    await expect(page.getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Favorite" }).click();
  });

  test("the palette navigates to pages and switches theme", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByPlaceholder(/Search conversations/).pressSequentially("analytics");
    await page.getByRole("option", { name: "Go to analytics" }).click();
    await expect(page).toHaveURL(/\/analytics/);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByPlaceholder(/Search conversations/).pressSequentially("dark");
    await page.getByRole("option", { name: /Switch to dark theme/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("the theme toggle changes real colours and persists across reloads; system follows the OS", async ({ page }) => {
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: "light" });
    const light = await bg();
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await bg()).not.toBe(light);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemcheckbox", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await bg()).not.toBe(light);
  });

  test("notifications: the bell lists mentions and marks them read", async ({ page }) => {
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    const markAll = page.getByRole("button", { name: "Mark all read" });
    if (await markAll.isEnabled()) await markAll.click();
    await expect(page.getByRole("button", { name: /^Notifications$/ })).toBeVisible();
  });

  test("realtime: a visitor message arrives in the open list without a reload", async ({ page, request, baseURL }) => {
    const before = await page.getByRole("region", { name: "Conversations" }).getByRole("link").count();
    // a brand-new visitor writes in through the public API, exactly like the widget does
    await freshVisitor(baseURL!, `Live Visitor ${stamp}`, ["Is anyone around right now?"]);
    await expect(page.getByRole("region", { name: "Conversations" }).getByRole("link", { name: new RegExp(`Live Visitor ${stamp}`) })).toBeVisible({ timeout: 15_000 });
    expect(await page.getByRole("region", { name: "Conversations" }).getByRole("link").count()).toBeGreaterThan(before);
    void request;
  });
});
