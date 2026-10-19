import { describe, expect, it, vi } from "vitest";
import { CancelledError, WorkerClient } from "./client";
import { diffRooms, roomSig } from "./logic/diff";
import { previewContactsCsv, parseCsv } from "./logic/csv";
import { splitQuoted } from "./logic/email";
import { fold, searchItems } from "./logic/search";
import { ops } from "./ops";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { scrollToReveal, windowRange } from "../lib/virtual";

describe("thread search", () => {
  const items = [
    { id: "1", text: "Hello, I need a refund for my order", sender: "Ann", at: "t1" },
    { id: "2", text: "Sure! Your café order #42 shipped", sender: "Bo", at: "t2" },
    { id: "3", text: "Where is my ORDER?", sender: "Ann", at: "t3" },
  ];
  it("finds substrings case- and accent-insensitively, newest first, with highlight ranges", () => {
    const hits = searchItems(items, "order", 10);
    expect(hits.map((h) => h.id)).toEqual(["3", "2", "1"]);
    const h = hits[1]!;
    expect(h.snippet.slice(h.ranges[0]![0], h.ranges[0]![1]).toLowerCase()).toBe("order");
    expect(searchItems(items, "CAFE", 10).map((x) => x.id)).toEqual(["2"]);
    expect(fold("Café")).toBe("cafe");
  });
  it("honours the limit, empty queries and special characters literally", () => {
    expect(searchItems(items, "order", 1)).toHaveLength(1);
    expect(searchItems(items, "   ", 10)).toEqual([]);
    expect(searchItems(items, "#42", 10).map((x) => x.id)).toEqual(["2"]);
    expect(searchItems(items, ".*", 10)).toEqual([]);
  });
  it("truncates long messages around the match with ellipses, keeping ranges aligned", () => {
    const long = [{ id: "x", text: "a".repeat(200) + " needle " + "b".repeat(200), sender: "s", at: "t" }];
    const [h] = searchItems(long, "needle", 5);
    expect(h!.snippet.startsWith("…")).toBe(true);
    expect(h!.snippet.endsWith("…")).toBe(true);
    expect(h!.snippet.slice(h!.ranges[0]![0], h!.ranges[0]![1])).toBe("needle");
  });
  it("is cancellable between chunks and fast on 100k messages", () => {
    const big = Array.from({ length: 100_000 }, (_, i) => ({ id: String(i), text: `message number ${i} about something`, sender: "s", at: "t" }));
    let polls = 0;
    expect(() => searchItems(big, "zzzzz", 10, () => ++polls > 3)).toThrow("cancelled");
    const t = performance.now();
    expect(searchItems(big, "number 99999", 5).map((x) => x.id)).toEqual(["99999"]);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("contacts csv preview", () => {
  it("parses quotes, CRLF, BOM and embedded newlines", () => {
    expect(parseCsv('﻿name,email\r\n"Lee, Dana",d@x.test\r\n"two\nlines",\r\n')).toEqual([["name", "email"], ["Lee, Dana", "d@x.test"], ["two\nlines", ""]]);
  });
  it("validates rows and reports counts and problems with row numbers", () => {
    const csv = ["Name,Email,Phone,Tags", "Ann,ann@example.test,+14155552671,vip", "Bob,not-an-email,,", ",,,", "Cy,,12,", "Di,di@example.test,(415) 555-0199,"].join("\n");
    const p = previewContactsCsv(csv, 2);
    expect(p).toMatchObject({ total: 4, valid: 2, recognised: { name: true, email: true, phone: true, tags: true } });
    expect(p.preview).toHaveLength(2);
    expect(p.errors.map((e) => e.row)).toEqual([3, 4]); // fully blank lines are dropped by the parser, like the server importer
    expect(p.errors[0]!.error).toContain("not a valid email");
  });
  it("flags files without a usable header and tolerates empty input", () => {
    expect(previewContactsCsv("foo,bar\n1,2", 5).errors[0]).toEqual({ row: 1, error: "Header needs at least one of: name, email, phone, tags" });
    expect(previewContactsCsv("", 5)).toMatchObject({ total: 0, valid: 0 });
  });
  it("cancels mid-parse and handles 50k rows quickly", () => {
    const big = "name,email\n" + Array.from({ length: 50_000 }, (_, i) => `P${i},p${i}@example.test`).join("\n");
    let polls = 0;
    expect(() => previewContactsCsv(big, 5, () => ++polls > 2)).toThrow("cancelled");
    const t = performance.now();
    expect(previewContactsCsv(big, 5).valid).toBe(50_000);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});

describe("email quoted-text splitting", () => {
  it("separates the reply from quoted history", () => {
    const body = "Thanks, that works.\n\nOn Mon, 2 Mar 2026 at 10:00, Support <s@acme.test> wrote:\n> Did you try restarting?\n> Let us know.";
    const r = splitQuoted(body);
    expect(r.main).toBe("Thanks, that works.");
    expect(r.quoted).toContain("Did you try restarting?");
  });
  it("handles > blocks, Outlook markers and signatures; leaves plain mail alone", () => {
    expect(splitQuoted("Yes.\n> old\n> older").main).toBe("Yes.");
    expect(splitQuoted("Ok\n\n-----Original Message-----\nFrom: a\nSent: b").quoted).toContain("Original Message");
    expect(splitQuoted("Regards\n-- \nAnn\nAcme").main).toBe("Regards");
    const plain = "Just a normal message\nwith two lines";
    expect(splitQuoted(plain)).toEqual({ main: plain, quoted: "" });
  });
  it("never hides a message that is only quoted text", () => {
    const all = "> forwarded\n> content";
    expect(splitQuoted(all)).toEqual({ main: all, quoted: "" });
  });
});

describe("room list diff", () => {
  const r = (id: string, sig = "a") => ({ id, sig });
  it("reports added, removed, changed and moved rooms", () => {
    const d = diffRooms([r("1"), r("2"), r("3"), r("4")], [r("2"), r("1"), r("3", "b"), r("5")]);
    expect(d).toEqual({ added: ["5"], removed: ["4"], changed: ["3"], moved: ["2", "1"] });
  });
  it("is empty for identical lists and builds a signature from the fields that matter", () => {
    expect(diffRooms([r("1")], [r("1")])).toEqual({ added: [], removed: [], changed: [], moved: [] });
    const a = { updated_at: "t", unread_count: 1, status: "open", priority: 0, assignee_ids: ["m1"] };
    expect(roomSig(a)).not.toBe(roomSig({ ...a, unread_count: 2 }));
    expect(roomSig(a)).toBe(roomSig({ ...a }));
  });
  it("handles 5,000 rooms quickly", () => {
    const list = Array.from({ length: 5000 }, (_, i) => r(String(i), "x"));
    const next = [...list.slice(1), { id: "new", sig: "y" }];
    const t = performance.now();
    const d = diffRooms(list, next);
    expect(performance.now() - t).toBeLessThan(200);
    expect(d.added).toEqual(["new"]);
    expect(d.removed).toEqual(["0"]);
  });
});

describe("virtual window", () => {
  it("renders only the visible rows plus overscan and pads the rest", () => {
    expect(windowRange(0, 600, 60, 1000, 2)).toEqual({ start: 0, end: 13, padTop: 0, padBottom: 987 * 60 });
    const w = windowRange(6000, 600, 60, 1000, 2);
    expect(w.start).toBe(98);
    expect(w.end).toBe(113);
    expect(w.padTop + (w.end - w.start) * 60 + w.padBottom).toBe(1000 * 60);
  });
  it("clamps at the end and handles empty lists", () => {
    const w = windowRange(1_000_000, 600, 60, 100, 3);
    expect(w.end).toBe(100);
    expect(w.padBottom).toBe(0);
    expect(windowRange(0, 600, 60, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });
  it("scrolls a row into view only when needed", () => {
    expect(scrollToReveal(5, 60, 600, 0)).toBeNull();
    expect(scrollToReveal(20, 60, 600, 0)).toBe(660);
    expect(scrollToReveal(2, 60, 600, 600)).toBe(120);
  });
});

/** A fake worker that executes requests through the same ops table, asynchronously, like the real one. */
function fakeWorker(behaviour: { crash?: boolean; slow?: boolean } = {}) {
  const w: any = {
    onmessage: null as ((e: MessageEvent<WorkerResponse>) => void) | null,
    onerror: null as (() => void) | null,
    cancelled: new Set<number>(),
    terminated: false,
    messages: [] as WorkerRequest[],
    terminate() {
      this.terminated = true;
    },
    postMessage(m: WorkerRequest) {
      this.messages.push(m);
      if (m.op === "cancel") {
        this.cancelled.add(m.id);
        return;
      }
      if (behaviour.crash) return void setTimeout(() => this.onerror?.(), 0);
      setTimeout(() => {
        if (this.cancelled.has(m.id)) return this.onmessage?.({ data: { id: m.id, ok: false, error: "cancelled", cancelled: true } } as MessageEvent<WorkerResponse>);
        const result = (ops[m.op] as (i: unknown, c: () => boolean) => unknown)(m.payload, () => false);
        this.onmessage?.({ data: { id: m.id, ok: true, result } } as MessageEvent<WorkerResponse>);
      }, behaviour.slow ? 30 : 0);
    },
  };
  return w;
}

describe("WorkerClient", () => {
  const items = [{ id: "1", text: "refund please", sender: "a", at: "t" }];
  it("routes requests through the worker and returns its results", async () => {
    const w = fakeWorker();
    const c = new WorkerClient(() => w);
    expect((await c.run("search", { items, query: "refund", limit: 5 })).map((h) => h.id)).toEqual(["1"]);
    expect(c.usingWorker).toBe(true);
    expect(w.messages[0]).toMatchObject({ op: "search" });
  });
  it("answers concurrent requests independently and in the right order", async () => {
    const c = new WorkerClient(() => fakeWorker({ slow: true }));
    const [a, b] = await Promise.all([c.run("email", { text: "x\n> q" }), c.run("diff", { prev: [], next: [{ id: "1", sig: "s" }] })]);
    expect(a.main).toBe("x");
    expect(b.added).toEqual(["1"]);
  });
  it("runs inline when Workers are unavailable (no factory) or fail to construct", async () => {
    expect((await new WorkerClient(null).run("email", { text: "ok" })).main).toBe("ok");
    const c = new WorkerClient(() => {
      throw new Error("blocked by CSP");
    });
    expect((await c.run("email", { text: "ok" })).main).toBe("ok");
    expect(c.usingWorker).toBe(false);
  });
  it("falls back inline for the failing call and for later ones when the worker crashes", async () => {
    const w = fakeWorker({ crash: true });
    const c = new WorkerClient(() => w);
    expect((await c.run("search", { items, query: "refund", limit: 5 })).length).toBe(1);
    expect(w.terminated).toBe(true);
    expect(c.usingWorker).toBe(false);
    expect((await c.run("search", { items, query: "refund", limit: 5 })).length).toBe(1);
  });
  it("cancels in-flight work: posts a cancel message and rejects with CancelledError", async () => {
    const w = fakeWorker({ slow: true });
    const c = new WorkerClient(() => w);
    const ac = new AbortController();
    const p = c.run("search", { items, query: "refund", limit: 5 }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(w.messages.some((m: WorkerRequest) => m.op === "cancel")).toBe(true);
    await expect(c.run("search", { items, query: "x", limit: 1 }, { signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
  });
  it("skips the round trip for small payloads", async () => {
    const w = fakeWorker();
    const c = new WorkerClient(() => w);
    await c.run("email", { text: "tiny" }, { size: 10, inlineBelow: 1000 });
    expect(w.messages).toHaveLength(0);
    await c.run("email", { text: "big" }, { size: 5000, inlineBelow: 1000 });
    expect(w.messages).toHaveLength(1);
  });
  it("terminates cleanly", () => {
    const w = fakeWorker();
    const c = new WorkerClient(() => w);
    void c.run("email", { text: "x" });
    const spy = vi.spyOn(w, "terminate");
    c.terminate();
    expect(spy).toHaveBeenCalled();
  });
});
