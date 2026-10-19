import { describe, expect, it } from "vitest";
import { selectRecipients, notifyContactMessage, notifyMentions, unreadNotificationCount } from "../src/services/notifications.js";
import { collectDigests } from "../src/services/digest.js";
import { tick } from "../src/jobs/scheduler.js";
import { enqueueJob, runDueJobs } from "../src/jobs/queue.js";
import { markRead, snoozeRoom, assignRoom } from "../src/services/rooms.js";
import { updateMember, memberScope } from "../src/services/members.js";
import { onContactMessage } from "../src/services/postProcess.js";
import { addMemberRaw, contactSays, fullApp, messagesOf, mkInbox, mkRoom, roomRow, tokenFor } from "./helpers.js";

async function world() {
  const f = await fullApp();
  const ann = await addMemberRaw(f.ctx, f.wsId, { name: "Ann", email: "ann@acme.test" });
  const bo = await addMemberRaw(f.ctx, f.wsId, { name: "Bo", email: "bo@acme.test" });
  const cy = await addMemberRaw(f.ctx, f.wsId, { name: "Cy", email: "cy@acme.test", role: "manager" });
  const inbox = mkInbox(f.ctx, f.owner, { name: "Team", member_ids: [ann.memberId, bo.memberId] });
  const goOnline = (a: { memberId: string }) => f.ctx.presence.connect(memberScope(f.wsId), a.memberId, `sock-${a.memberId}`);
  return { ...f, ann, bo, cy, inbox, goOnline };
}
const tiers = (r: ReturnType<typeof selectRecipients>) => Object.fromEntries(r.map((x) => [x.member.name, x.tier]));

describe("recipient tiers", () => {
  it("assigned room: assignee, then inbox team; managers are not bothered", async () => {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId, { inboxId: w.inbox.id, assignees: [w.ann] });
    expect(tiers(selectRecipients(w.ctx, roomRow(w.ctx, room.id)))).toEqual({ Ann: "assigned_to_you", Bo: "assigned_to_your_team" });
  });
  it("unassigned room: inbox team plus owners/managers (most specific tier wins, no duplicates)", async () => {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId, { inboxId: w.inbox.id });
    expect(tiers(selectRecipients(w.ctx, roomRow(w.ctx, room.id)))).toEqual({ Ann: "assigned_to_your_team", Bo: "assigned_to_your_team", "Olivia Owner": "unassigned", Cy: "unassigned" });
    const noInbox = mkRoom(w.ctx, w.wsId);
    expect(tiers(selectRecipients(w.ctx, roomRow(w.ctx, noInbox.room.id)))).toEqual({ "Olivia Owner": "unassigned", Cy: "unassigned" });
  });
  it("a manager who is also an assignee or team member is listed once under the specific tier", async () => {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId, { assignees: [w.cy] });
    const r = selectRecipients(w.ctx, roomRow(w.ctx, room.id));
    expect(r.filter((x) => x.member.name === "Cy")).toEqual([expect.objectContaining({ tier: "assigned_to_you" })]);
    expect(r).toHaveLength(1);
  });
  it("honours per-seat tier preferences, inactive seats and seats without a live seat", async () => {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId, { inboxId: w.inbox.id });
    updateMember(w.ctx, w.owner, w.ann.memberId, { notification_prefs: { assigned_to_your_team: false } });
    updateMember(w.ctx, w.owner, w.bo.memberId, { availability: "inactive" });
    updateMember(w.ctx, w.owner, w.cy.memberId, { live_seat: false });
    expect(tiers(selectRecipients(w.ctx, roomRow(w.ctx, room.id)))).toEqual({ "Olivia Owner": "unassigned" });
    updateMember(w.ctx, w.owner, w.owner.memberId, { notification_prefs: { unassigned: false } });
    expect(selectRecipients(w.ctx, roomRow(w.ctx, room.id))).toEqual([]);
  });
  it("snoozed rooms notify nobody", async () => {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId, { assignees: [w.ann] });
    snoozeRoom(w.ctx, w.owner, room.id, new Date(w.ctx.clock().getTime() + 3600_000).toISOString());
    expect(selectRecipients(w.ctx, roomRow(w.ctx, room.id))).toEqual([]);
  });
});

describe("in-app feed", () => {
  it("creates one entry per seat per message (deduped), exposes badge counts and read state", async () => {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId, { assignees: [w.ann], contact: { name: "Dana" } });
    const m = contactSays(w.ctx, room, "Where is my order?");
    notifyContactMessage(w.ctx, roomRow(w.ctx, room.id), m);
    notifyContactMessage(w.ctx, roomRow(w.ctx, room.id), m); // duplicate trigger
    expect(unreadNotificationCount(w.ctx, w.ann.memberId)).toBe(1);
    const t = await tokenFor(w.ctx, w.ann);
    const feed = await w.http.get("/api/notifications", t);
    expect(feed.body.unread_count).toBe(1);
    expect(feed.body.data[0]).toMatchObject({ type: "message", room_id: room.id, title: "New message from Dana", body: "Where is my order?" });
    expect((await w.http.get("/api/notifications?unread_only=true", t)).body.data).toHaveLength(1);
    // someone else cannot read my notification
    expect((await w.http.post(`/api/notifications/${feed.body.data[0].id}/read`, {}, await tokenFor(w.ctx, w.bo))).status).toBe(404);
    expect((await w.http.post(`/api/notifications/${feed.body.data[0].id}/read`, {}, t)).body.unread_count).toBe(0);
    expect((await w.http.get("/api/notifications?unread_only=true", t)).body.data).toHaveLength(0);
    contactSays(w.ctx, room, "hello?");
    notifyContactMessage(w.ctx, roomRow(w.ctx, room.id), messagesOf(w.ctx, room.id).pop()!);
    expect((await w.http.post("/api/notifications/read-all", {}, t)).body.unread_count).toBe(0);
    expect(unreadNotificationCount(w.ctx, w.ann.memberId)).toBe(0);
  });
  it("mentions notify the mentioned seat unless they opted out, never the author", async () => {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId);
    const m = contactSays(w.ctx, room, "note-ish");
    updateMember(w.ctx, w.owner, w.bo.memberId, { notification_prefs: { mentions: false } });
    notifyMentions(w.ctx, roomRow(w.ctx, room.id), m, w.ann, [w.ann.memberId, w.bo.memberId, w.cy.memberId]);
    expect(unreadNotificationCount(w.ctx, w.ann.memberId)).toBe(0);
    expect(unreadNotificationCount(w.ctx, w.bo.memberId)).toBe(0);
    expect(unreadNotificationCount(w.ctx, w.cy.memberId)).toBe(1);
  });
});

describe("offline notification emails", () => {
  async function ready() {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId, { assignees: [w.ann], contact: { name: "Dana" } });
    const msg = (text = "Help please") => contactSays(w.ctx, room, text);
    const fire = async (m = msg()) => {
      notifyContactMessage(w.ctx, roomRow(w.ctx, room.id), m);
      await tick(w.ctx, { jobs: true });
    };
    return { ...w, room, msg, fire };
  }
  it("emails an offline assignee with a link to the conversation", async () => {
    const w = await ready();
    await w.fire();
    expect(w.ctx.email.sent).toHaveLength(1);
    expect(w.ctx.email.sent[0]).toMatchObject({ to: "ann@acme.test", subject: "New message from Dana" });
    expect(w.ctx.email.sent[0]!.text).toContain(`/inbox/${w.room.id}`);
    expect(w.ctx.db.get("SELECT COUNT(*) n FROM notifications WHERE emailed_at IS NOT NULL")).toEqual({ n: 1 });
  });
  it("skips seats that are online, in DND, or opted out of email; only the assignee tier is emailed immediately", async () => {
    const w = await ready();
    w.goOnline(w.ann);
    await w.fire();
    expect(w.ctx.email.sent).toHaveLength(0);
    w.ctx.presence.disconnect(memberScope(w.wsId), w.ann.memberId, `sock-${w.ann.memberId}`);
    w.ctx.clockCtl.advance(10_000); // presence grace is real-timer based; force offline for the rest of this test
    (w.ctx.presence as any).online.clear();
    updateMember(w.ctx, w.owner, w.ann.memberId, { dnd_until: new Date(w.ctx.clock().getTime() + 3600_000).toISOString() });
    await w.fire();
    expect(w.ctx.email.sent).toHaveLength(0);
    updateMember(w.ctx, w.owner, w.ann.memberId, { dnd_until: null, notification_prefs: { email: false } });
    await w.fire();
    expect(w.ctx.email.sent).toHaveLength(0);
    updateMember(w.ctx, w.owner, w.ann.memberId, { notification_prefs: { email: true } });
    await w.fire();
    expect(w.ctx.email.sent.map((e) => e.to)).toEqual(["ann@acme.test"]); // Bo (team tier) is never emailed immediately
  });
  it("DND that has already ended does not suppress", async () => {
    const w = await ready();
    updateMember(w.ctx, w.owner, w.ann.memberId, { dnd_until: new Date(w.ctx.clock().getTime() + 1000).toISOString() });
    w.ctx.clockCtl.advance(2000);
    await w.fire();
    expect(w.ctx.email.sent).toHaveLength(1);
  });
  it("re-checks at send time: coming online, or the room being snoozed, between enqueue and send cancels the email", async () => {
    const w = await ready();
    notifyContactMessage(w.ctx, roomRow(w.ctx, w.room.id), w.msg("one"));
    w.goOnline(w.ann);
    await tick(w.ctx, { jobs: true });
    expect(w.ctx.email.sent).toHaveLength(0);
    (w.ctx.presence as any).online.clear();
    (w.ctx.presence as any).sockets.clear();
    notifyContactMessage(w.ctx, roomRow(w.ctx, w.room.id), w.msg("two"));
    snoozeRoom(w.ctx, w.owner, w.room.id, new Date(w.ctx.clock().getTime() + 3600_000).toISOString());
    await tick(w.ctx, { jobs: true });
    expect(w.ctx.email.sent).toHaveLength(0);
  });
  it("sends each notification once even if the job table is run repeatedly", async () => {
    const w = await ready();
    await w.fire();
    await tick(w.ctx, { jobs: true });
    await tick(w.ctx, { jobs: true });
    expect(w.ctx.email.sent).toHaveLength(1);
  });
  it("the post-processing hook (triggered by a stored contact message) creates the notification in the background", async () => {
    const w = await ready();
    const m = w.msg("via hook");
    onContactMessage(w.ctx, roomRow(w.ctx, w.room.id), m);
    await w.ctx.background.settle();
    expect(unreadNotificationCount(w.ctx, w.ann.memberId)).toBe(1);
  });
});

describe("job queue", () => {
  it("dedupes by key, retries with exponential backoff and parks permanently failing jobs", async () => {
    const w = await fullApp();
    expect(enqueueJob(w.ctx, "boom", { n: 1 }, { dedupeKey: "k1", maxAttempts: 3 })).toBe(true);
    expect(enqueueJob(w.ctx, "boom", { n: 2 }, { dedupeKey: "k1" })).toBe(false);
    let calls = 0;
    const handlers = { boom: () => { calls++; throw new Error("nope"); } };
    expect(await runDueJobs(w.ctx, handlers)).toEqual({ ran: 0, failed: 1 });
    expect(await runDueJobs(w.ctx, handlers)).toEqual({ ran: 0, failed: 0 }); // backing off
    w.ctx.clockCtl.advance(3_000);
    await runDueJobs(w.ctx, handlers);
    w.ctx.clockCtl.advance(5_000);
    await runDueJobs(w.ctx, handlers);
    expect(calls).toBe(3);
    expect(w.ctx.db.get("SELECT status, attempts, last_error FROM jobs")).toEqual({ status: "failed", attempts: 3, last_error: "nope" });
    w.ctx.clockCtl.advance(3600_000);
    expect(await runDueJobs(w.ctx, handlers)).toEqual({ ran: 0, failed: 0 });
  });
  it("runs future jobs only when due and reports unknown types as failures", async () => {
    const w = await fullApp();
    let ran = 0;
    enqueueJob(w.ctx, "later", {}, { runAt: new Date(w.ctx.clock().getTime() + 60_000) });
    enqueueJob(w.ctx, "mystery", {});
    expect((await runDueJobs(w.ctx, { later: () => void ran++ })).failed).toBe(1);
    w.ctx.clockCtl.advance(61_000);
    await runDueJobs(w.ctx, { later: () => void ran++ });
    expect(ran).toBe(1);
  });
  it("a claimed job is not run twice (conditional claim)", async () => {
    const w = await fullApp();
    enqueueJob(w.ctx, "once", {});
    let ran = 0;
    await Promise.all([runDueJobs(w.ctx, { once: async () => void ran++ }), runDueJobs(w.ctx, { once: async () => void ran++ })]);
    expect(ran).toBe(1);
  });
});

describe("delayed-message digest", () => {
  const MIN = 60_000;
  async function digestWorld() {
    const w = await world();
    const { room } = mkRoom(w.ctx, w.wsId, { assignees: [w.ann], inboxId: w.inbox.id, contact: { name: "Dana" } });
    const say = (t: string) => contactSays(w.ctx, room, t);
    const run = async () => {
      const c = collectDigests(w.ctx);
      await tick(w.ctx, { jobs: true });
      return c;
    };
    const digestMails = () => w.ctx.email.sent.filter((e) => /waiting|Unanswered/.test(e.subject));
    return { ...w, room, say, run, digestMails };
  }
  it("waits for the minimum age, then queues one email per seat and sends exactly once", async () => {
    // Unread follows the read-cursor rule: on an assigned room only the assignee has unread messages, so only they are digested.
    const w = await digestWorld();
    w.say("still there?");
    w.ctx.clockCtl.advance(1 * MIN);
    expect((await w.run()).queued).toBe(0);
    w.ctx.clockCtl.advance(2 * MIN);
    expect((await w.run()).queued).toBe(1);
    const mails = w.digestMails();
    expect(mails.map((m) => m.to)).toEqual(["ann@acme.test"]);
    expect(mails[0]!.subject).toBe("Unanswered message from Dana");
    expect(mails[0]!.text).toContain(`/inbox/${w.room.id}`);
    // running again changes nothing: the room's digest cursor moved
    w.ctx.clockCtl.advance(5 * MIN);
    expect((await w.run()).queued).toBe(0);
    expect(w.digestMails()).toHaveLength(1);
    // a new unanswered message produces a new digest
    w.say("hello??");
    w.ctx.clockCtl.advance(3 * MIN);
    expect((await w.run()).queued).toBe(1);
    expect(w.digestMails()).toHaveLength(2);
  });
  it("skips seats that are online, in DND, opted out, or already read the thread", async () => {
    const w = await digestWorld();
    const m = w.say("ping");
    w.ctx.clockCtl.advance(3 * MIN);
    w.goOnline(w.ann);
    updateMember(w.ctx, w.owner, w.bo.memberId, { dnd_until: new Date(w.ctx.clock().getTime() + 3600_000).toISOString() });
    expect((await w.run()).queued).toBe(0);
    // cursor already advanced, so the same messages never come back
    w.ctx.presence.disconnect(memberScope(w.wsId), w.ann.memberId, `sock-${w.ann.memberId}`);
    expect(m.id).toBeTruthy();
  });
  it("skips seats with delayed_msgs off and seats that have read the message", async () => {
    const w = await digestWorld();
    const m = w.say("ping");
    updateMember(w.ctx, w.owner, w.bo.memberId, { notification_prefs: { delayed_msgs: false } });
    markRead(w.ctx, w.ann, w.room.id, m.id);
    w.ctx.clockCtl.advance(3 * MIN);
    expect((await w.run()).queued).toBe(0);
    expect(w.digestMails()).toHaveLength(0);
  });
  it("does not duplicate what the immediate offline email already told the assignee", async () => {
    const w = await digestWorld();
    const m = w.say("urgent");
    notifyContactMessage(w.ctx, roomRow(w.ctx, w.room.id), m);
    await tick(w.ctx, { jobs: true });
    expect(w.ctx.email.sent.map((e) => e.to)).toEqual(["ann@acme.test"]);
    w.ctx.clockCtl.advance(3 * MIN);
    await w.run();
    expect(w.digestMails()).toHaveLength(0); // Ann was already emailed; Bo has no unread on a room assigned to Ann
  });
  it("unassigned rooms digest to the inbox team and to managers; snoozed and closed rooms are skipped", async () => {
    const w = await digestWorld();
    const un = mkRoom(w.ctx, w.wsId, { inboxId: w.inbox.id, contact: { name: "Eve" } });
    contactSays(w.ctx, un.room, "anyone?");
    assignRoom(w.ctx, w.owner, w.room.id, { member_ids: [] });
    const sn = mkRoom(w.ctx, w.wsId, { contact: { name: "Snoozed" } });
    contactSays(w.ctx, sn.room, "later");
    snoozeRoom(w.ctx, w.owner, sn.room.id, new Date(w.ctx.clock().getTime() + 3600_000 * 5).toISOString());
    w.ctx.clockCtl.advance(3 * MIN);
    await w.run();
    const byTo = Object.fromEntries(w.digestMails().map((m) => [m.to, m.subject]));
    expect(Object.keys(byTo)).toHaveLength(4);
    expect(Object.keys(byTo)).toEqual(expect.arrayContaining(["ann@acme.test", "bo@acme.test", "cy@acme.test"]));
    expect(Object.values(byTo).join(" ")).not.toContain("Snoozed");
  });
  it("folds several rooms into one email per seat and ignores messages older than the max age", async () => {
    const w = await digestWorld();
    const r2 = mkRoom(w.ctx, w.wsId, { assignees: [w.ann], contact: { name: "Fay" } });
    w.say("one");
    contactSays(w.ctx, r2.room, "two");
    w.ctx.clockCtl.advance(3 * MIN);
    await w.run();
    const annMail = w.digestMails().find((m) => m.to === "ann@acme.test")!;
    expect(annMail.subject).toBe("2 conversations are waiting for a reply");
    // stale messages (older than 60 minutes) are skipped silently
    w.ctx.clockCtl.advance(2 * 3600_000);
    const stale = w.say("old news");
    w.ctx.clockCtl.advance(70 * MIN);
    const before = w.digestMails().length;
    await w.run();
    expect(w.digestMails()).toHaveLength(before);
    expect(roomRow(w.ctx, w.room.id).digest_seq).toBe(stale.seq);
  });
});
