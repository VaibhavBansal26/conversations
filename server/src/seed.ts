import { pathToFileURL } from "node:url";
import { createContext } from "./app-context.js";
import { loadConfig } from "./config.js";
import { RecordingBus } from "./realtime/bus.js";
import { register } from "./services/auth.js";
import { createContact, type ContactInput } from "./services/contacts.js";
import { addMember, getMember, actorFromRow } from "./services/members.js";
import { createInbox } from "./services/inboxes.js";
import { sendAgentMessage } from "./services/messages.js";
import { insertMessage } from "./services/messageStore.js";
import { findOrCreateRoom, setPriority, setStatus, snoozeRoom, assignRoom } from "./services/rooms.js";
import { addInboundAddress, addSender, addSmsNumber, createKb, updateSender } from "./services/settings.js";
import { createTemplate } from "./services/templates.js";
import { createToken } from "./services/visitors.js";
import { updateWorkspace } from "./services/workspaces.js";
import type { Actor } from "./domain/types.js";

export const DEMO_EMAIL = "demo@example.test";
export const DEMO_PASSWORD = "demo-password-123";

/** Development seed: a realistic demo workspace so the UI is not empty. Refuses to run in production. */
export async function seed(env: Record<string, string | undefined> = process.env) {
  const config = loadConfig(env);
  if (config.NODE_ENV === "production") throw new Error("Refusing to seed in production");
  const ctx = createContext(config, { bus: new RecordingBus() });
  if (ctx.db.get("SELECT 1 FROM users WHERE email = ?", DEMO_EMAIL)) {
    console.log(`Already seeded. Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    return;
  }
  const real = ctx.clock;
  let t = real().getTime() - 2 * 86400_000;
  ctx.clock = () => new Date(t);
  const tick = (minutes: number) => void (t += minutes * 60_000);

  const reg = await register(ctx, { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: "Demo Owner", workspace_name: "Demo Co" });
  const ws = reg.workspace.id;
  const owner: Actor = actorFromRow(getMember(ctx, ws, reg.member.id));
  const person = async (name: string, email: string, role: "manager" | "agent") => actorFromRow(await addMember(ctx, owner, { name, email, password: DEMO_PASSWORD, role }));
  const maya = await person("Maya Manager", "maya@example.test", "manager");
  const sam = await person("Sam Agent", "sam@example.test", "agent");
  const priya = await person("Priya Agent", "priya@example.test", "agent");

  updateWorkspace(ctx, ws, { settings: { widget: { title: "Chat with Demo Co", intro: "We usually reply in a few minutes.", primary_color: "#0f766e", required_info: ["name"] } } });
  const sales = createInbox(ctx, owner, { name: "Sales", icon: "tag", algorithm: "round_robin", member_ids: [sam.memberId, priya.memberId], live_routing_visibility: true });
  const support = createInbox(ctx, owner, { name: "Support", icon: "life-buoy", member_ids: [sam.memberId, maya.memberId], default_email_inbound: true, default_sms_inbound: true });

  addSmsNumber(ctx, owner, { e164: "+14155550100", label: "Main line", is_default: true });
  updateSender(ctx, owner, addSender(ctx, owner, { address: "support@demo.example.test", display_name: "Demo Co Support" }).id, { verified: true, is_default: true });
  addInboundAddress(ctx, owner, "inbound@parse.demo.example.test");
  createToken(ctx, owner, "localhost:5173");
  createToken(ctx, owner, "localhost:3000");

  for (const [question, answer] of [
    ["What are your opening hours?", "We are open Monday to Friday, 9am to 5pm Eastern."],
    ["How long does shipping take?", "Standard shipping takes 3-5 business days. Express takes 1-2."],
    ["How do I reset my password?", "Use the 'Forgot password' link on the sign-in page and follow the emailed instructions."],
    ["What is your refund policy?", "Refunds are available within 30 days of purchase for unused items."],
    ["Do you ship internationally?", "Yes, we ship to more than 40 countries."],
  ] as const) createKb(ctx, owner, { question, answer });

  for (const tpl of [
    { name: "Greeting", channel: "any" as const, shortcut: "hi", body: "Hi {{contact.first_name|there}}, thanks for reaching out! This is {{agent.name}} from {{workspace.name}}. How can I help?" },
    { name: "Order status", channel: "email" as const, shortcut: "status", subject: "About your order", body: "Hi {{contact.first_name|there}},\n\nI'm checking on your order now and will update you shortly.\n\n{{agent.name}}" },
    { name: "SMS follow-up", channel: "sms" as const, shortcut: "follow", body: "Hi {{contact.first_name|there}}, just following up. Reply here any time. - {{workspace.name}}" },
    { name: "Closing", channel: "any" as const, shortcut: "bye", body: "Glad I could help, {{contact.first_name|friend}}! Reach out any time." },
  ]) createTemplate(ctx, owner, tpl);

  const contact = (c: ContactInput) => createContact(ctx, ws, { source: "seed", ...c });
  const room = (c: ContactInput, inboxId: string | null) => findOrCreateRoom(ctx, ws, { contactId: contact(c).id, inboxId }).room;
  const says = (roomId: string, text: string, source: "dm" | "sms" | "email" = "dm", subject?: string) => {
    tick(2);
    return insertMessage(ctx, { workspaceId: ws, roomId, senderType: "contact", kind: "text", source, content: text, contentText: text, subject: subject ?? null, senderName: ctx.db.get<{ name: string }>("SELECT c.name FROM contacts c JOIN rooms r ON r.contact_id = c.id WHERE r.id = ?", roomId)?.name ?? "Contact" }).message;
  };
  const reply = async (a: Actor, roomId: string, text: string, source: "dm" | "sms" | "email" = "dm") => {
    tick(3);
    await sendAgentMessage(ctx, a, roomId, { kind: "text", source, content: text });
  };

  const alice = room({ name: "Alice Johnson", email: "alice@example.test", phone: "(415) 555-2671", tags: ["vip"] }, sales.id);
  says(alice.id, "Hi! I'm interested in the Pro plan. Do you offer annual billing?");
  await reply(sam, alice.id, "Hi Alice, yes we do! Annual billing saves 15%. Want me to send a quote?");
  says(alice.id, "Yes please, for 5 seats.");

  const bob = room({ name: "Bob Martinez", phone: "(415) 555-0199", tags: ["trial"] }, support.id);
  says(bob.id, "My package hasn't arrived yet, order 48213", "sms");
  await reply(sam, bob.id, "Sorry about that Bob, let me look into it.", "sms");
  assignRoom(ctx, owner, bob.id, { member_ids: [sam.memberId] });

  const carol = room({ name: "Carol Singh", email: "carol@example.test" }, support.id);
  ctx.db.run("UPDATE rooms SET subject = ? WHERE id = ?", "Can't log in", carol.id);
  says(carol.id, "I keep getting an error when I try to sign in.", "email", "Can't log in");
  await reply(maya, carol.id, "Hi Carol, please try resetting your password with the link on the sign-in page.", "email");
  says(carol.id, "That worked, thank you!", "email", "Re: Can't log in");
  setStatus(ctx, maya, carol.id, "closed");

  const dave = room({ name: "Dave Kim", email: "dave@example.test" }, support.id);
  says(dave.id, "THE SITE IS DOWN and we are losing orders!!! Please help asap");
  setPriority(ctx, owner, dave.id, 1);

  const erin = room({ name: "Erin O'Neil", email: "erin@example.test", phone: "+442079460958", tags: ["wholesale"] }, sales.id);
  says(erin.id, "Can you share your wholesale price list?");
  await reply(priya, erin.id, "Absolutely, sending it over now.");
  await sendAgentMessage(ctx, priya, erin.id, { kind: "note", source: "dm", content: `Waiting on finance to approve the discount. cc @[Maya Manager](${maya.memberId})` });
  snoozeRoom(ctx, priya, erin.id, new Date(real().getTime() + 6 * 3600_000).toISOString());

  const frank = room({ name: "Frank Lopez", email: "frank@example.test" }, null);
  says(frank.id, "Hello? Is anyone there?");

  console.log(`Seeded demo workspace "Demo Co" (${ws}).\nLogin: ${DEMO_EMAIL} / ${DEMO_PASSWORD}  (also maya@, sam@, priya@example.test with the same password)`);
  await ctx.background.settle();
  ctx.db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
