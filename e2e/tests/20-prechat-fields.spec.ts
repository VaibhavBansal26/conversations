// Custom fields in the pre-chat form of the widget and of the hosted chat, in real Chrome against the built server: the fields the workspace asked
// for, required ones enforced (client and server), the consent box, answers stored on the contact. NOT exercised: other browsers, screen readers.
import AxeBuilder from "@axe-core/playwright";
import { expect, stamp, test } from "../support/fixtures";
import { loginApi } from "../support/api.mjs";
import { startCustomerSite } from "../support/site";

async function req(base: string, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const VI = {
  fields: { name: "required", email: "optional", phone: "off" },
  custom_fields: [
    { key: "plan", label: "Your plan", type: "select", options: ["Free", "Pro"], mode: "required" },
    { key: "order_no", label: "Order number", type: "text", mode: "optional" },
    { key: "terms", label: "I accept the terms of service", type: "checkbox", mode: "required" },
  ],
  consent: { enabled: true, text: "You may email me about this conversation.", privacy_url: null },
};

test("the widget's pre-chat form asks for the custom fields, enforces the required ones and the consent, and stores the answers on the contact", async ({ page, baseURL }) => {
  const api = await loginApi(baseURL!);
  await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { widget: { visitor_info: VI } } });
  const site = await startCustomerSite(baseURL!);
  const email = `pre.${stamp}${Math.floor(Math.random() * 1e6)}@example.test`;
  try {
    await page.goto(site.url);
    await page.getByRole("button", { name: "Open chat" }).click();
    await page.getByLabel("Your name").fill(`Pre Chat ${stamp}`);
    await page.getByLabel(/^Email/).fill(email);
    await page.getByRole("button", { name: "Start chat" }).click();
    await expect(page.getByText("This is required")).toBeVisible();
    await expect(page.getByText("Please tick this box")).toBeVisible();
    await expect(page.getByText("Please agree to continue")).toBeVisible();
    await page.getByLabel("Your plan").selectOption("Pro");
    await page.getByLabel("Order number (optional)").fill("A-1001");
    await page.getByLabel("I accept the terms of service").check();
    await page.getByLabel(/You may email me/).check();
    await page.getByRole("button", { name: "Start chat" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    const contacts = (await req(baseURL!, api.token, "GET", `/contacts?q=${encodeURIComponent(email)}`)).data as { id: string; attrs?: Record<string, unknown> }[];
    const c = await req(baseURL!, api.token, "GET", `/contacts/${contacts[0]!.id}`);
    expect(c.attrs).toMatchObject({ plan: "Pro", order_no: "A-1001", terms: "yes" });
  } finally {
    await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { widget: { visitor_info: { fields: { name: "off", email: "off", phone: "off" }, custom_fields: [], consent: { enabled: false } } } } }).catch(() => {});
    await site.close();
  }
});

test("the hosted chat shows the same fields, translated around the workspace's own labels", async ({ page, baseURL }) => {
  const api = await loginApi(baseURL!);
  await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { widget: { visitor_info: VI } } });
  const domain = `prechat-${stamp}.example.com`;
  const t = await req(baseURL!, api.token, "POST", "/tokens", { domain, hosted_chat_enabled: true });
  try {
    await page.goto(`/chat?token=${t.token}&bridge=none&locale=es`);
    await expect(page.getByLabel("Your plan")).toBeVisible();
    await expect(page.getByText(/Order number \(opcional\)/)).toBeVisible();
    // no WCAG 2.1 A/AA violations in the form with its custom fields and the consent box
    const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    await page.getByLabel("Tu nombre").fill(`Ines ${stamp}`);
    await page.getByRole("button", { name: /Empezar|Iniciar/ }).click();
    await expect(page.getByText("Marca esta casilla")).toBeVisible();
    await expect(page.getByText("Este campo es obligatorio").first()).toBeVisible();
    await page.getByLabel("Your plan").selectOption("Free");
    await page.getByLabel("I accept the terms of service").check();
    await page.getByRole("button", { name: /Empezar|Iniciar/ }).click();
    await expect(page.getByRole("textbox").last()).toBeVisible();
    await expect(page.getByLabel("Your plan")).toHaveCount(0);
  } finally {
    await req(baseURL!, api.token, "PATCH", "/workspace", { settings: { widget: { visitor_info: { fields: { name: "off", email: "off", phone: "off" }, custom_fields: [], consent: { enabled: false } } } } }).catch(() => {});
  }
});
