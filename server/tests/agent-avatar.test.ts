import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, cleanAvatar } from "../src/agents/avatar.js";
import { agentWorld } from "./agent-helpers.js";
import { addMemberRaw, tokenFor, seedWorkspace } from "./helpers.js";
import { jpeg, png, webp } from "./support-images.js";
import { AGENT_PRESETS } from "../src/agents/presets.js";

const MARK = ["gps", "52.5200N", "13.4050E"].join("-"); // built at run time: nothing that looks like personal data is stored in the repo

describe("cleaning a portrait", () => {
  it("PNG: keeps the picture and drops text, EXIF and time chunks", () => {
    const img = png(96, 80, [{ type: "tEXt", data: Buffer.from(`Comment\0${MARK}`) }, { type: "eXIf", data: Buffer.from(MARK) }, { type: "tIME", data: Buffer.alloc(7) }, { type: "iTXt", data: Buffer.from(`k\0\0\0\0\0${MARK}`) }]);
    const out = cleanAvatar(img);
    expect(out).toMatchObject({ mime: "image/png", width: 96, height: 80 });
    expect(out.content.includes(Buffer.from(MARK))).toBe(false);
    for (const t of ["tEXt", "eXIf", "tIME", "iTXt"]) expect(out.content.includes(Buffer.from(t))).toBe(false);
    expect(out.content.subarray(0, 8).equals(img.subarray(0, 8))).toBe(true);
    expect(out.content.includes(Buffer.from("IDAT"))).toBe(true);
    expect(out.content.subarray(-8, -4).toString("latin1")).toBe("IEND");
  });

  it("JPEG: keeps JFIF and the picture, drops EXIF and comments", () => {
    const out = cleanAvatar(jpeg(100, 120, { exif: MARK }));
    expect(out).toMatchObject({ mime: "image/jpeg", width: 100, height: 120 });
    expect(out.content.includes(Buffer.from(MARK))).toBe(false);
    expect(out.content.includes(Buffer.from("JFIF"))).toBe(true);
    expect(out.content.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    expect(() => cleanAvatar(jpeg(100, 100, { progressive: true }))).toThrow(/baseline/);
  });

  it("WebP: drops the EXIF chunk and its flag, refuses animation", () => {
    const out = cleanAvatar(webp(90, 90, { exif: MARK }));
    expect(out).toMatchObject({ mime: "image/webp", width: 90, height: 90 });
    expect(out.content.includes(Buffer.from(MARK))).toBe(false);
    expect(out.content.includes(Buffer.from("EXIF"))).toBe(false);
    expect(out.content.readUInt32LE(4)).toBe(out.content.length - 8);
    const vp8x = out.content.indexOf("VP8X");
    expect(out.content[vp8x + 8]! & 0x08).toBe(0);
    expect(() => cleanAvatar(webp(90, 90, { animated: true }))).toThrow(/Animated/);
  });

  it("refuses by content, never by name: other types, oversize, tiny, huge, damaged, empty", () => {
    const t = (b: Buffer) => { try { cleanAvatar(b); return "ok"; } catch (e: any) { return e.code as string; } };
    expect(t(Buffer.from("GIF89a" + "x".repeat(40), "latin1"))).toBe("UNSUPPORTED_FILE_TYPE");
    expect(t(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBe("UNSUPPORTED_FILE_TYPE");
    expect(t(Buffer.from("%PDF-1.4 hello"))).toBe("UNSUPPORTED_FILE_TYPE");
    expect(t(Buffer.from("<html><body>hi</body></html>"))).toBe("UNSUPPORTED_FILE_TYPE");
    expect(t(Buffer.alloc(0))).toBe("INVALID_AVATAR");
    expect(t(png(32, 32))).toBe("INVALID_AVATAR");
    expect(t(png(5000, 10))).toBe("INVALID_AVATAR");
    expect(t(png(128, 128).subarray(0, 60))).toBe("INVALID_AVATAR");
    expect(t(Buffer.concat([png(128, 128), Buffer.alloc(AVATAR_MAX_BYTES)]))).toBe("FILE_TOO_LARGE");
    // a PNG with an animation chunk
    expect(t(png(128, 128, [{ type: "acTL", data: Buffer.alloc(8) }]))).toBe("INVALID_AVATAR");
  });
});

describe("the portrait through the API and to visitors", () => {
  const upload = (w: Awaited<ReturnType<typeof agentWorld>>, id: string, file: Buffer, token = w.token, type = "image/png", alt?: string) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file)], { type }), "me.png");
    if (alt !== undefined) form.append("alt", alt);
    return w.http.call("POST", `/api/agents/${id}/avatar`, { token, form });
  };

  it("a manager uploads, the agent shows the address and the alt text, and anyone can load the cleaned picture with safe headers", async () => {
    const w = await agentWorld();
    const r = await upload(w, w.agent.id, png(256, 256, [{ type: "tEXt", data: Buffer.from(`Comment\0${MARK}`) }]), w.token, "image/png", "Portrait of Aria, a friendly woman with short hair");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ avatar_uploaded: true, avatar_alt: "Portrait of Aria, a friendly woman with short hair", disclosure_label: "AI assistant" });
    expect(r.body.avatar_url).toMatch(new RegExp(`/avatars/agent/${w.agent.id}\\?v=[0-9a-f]{10}$`));
    const path = new URL(r.body.avatar_url).pathname + new URL(r.body.avatar_url).search;
    const res = await w.app.request(path); // no credentials
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.includes(Buffer.from(MARK))).toBe(false);
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    // visitors' widget configuration carries it, with the label next to it
    const cfg = await w.http.get("/public/widget/config", undefined, w.h());
    expect(cfg.body.ai).toMatchObject({ name: "Aria", label: "AI assistant", avatar_url: r.body.avatar_url, avatar_alt: expect.stringContaining("Portrait of Aria") });
    // the audit log says who and what, not the picture
    const audit = await w.ctx.db.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'ai_agent.avatar_set'");
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ mime: "image/png", width: 256, height: 256 });
  });

  it("the label that says it is an AI cannot be removed or shortened below two characters, with or without a photo", async () => {
    const w = await agentWorld();
    expect((await upload(w, w.agent.id, png())).status).toBe(200);
    for (const label of ["", " ", "A"]) expect((await w.http.patch(`/api/agents/${w.agent.id}`, { disclosure_label: label }, w.token)).status).toBe(400);
    const ok = await w.http.patch(`/api/agents/${w.agent.id}`, { disclosure_label: "Virtual assistant" }, w.token);
    expect(ok.body).toMatchObject({ disclosure_label: "Virtual assistant", avatar_uploaded: true });
    const cfg = await w.http.get("/public/widget/config", undefined, w.h());
    expect(cfg.body.ai.label).toBe("Virtual assistant");
  });

  it("refuses bad files with the right codes, and people without the AI agents permission", async () => {
    const w = await agentWorld();
    expect((await upload(w, w.agent.id, Buffer.from("not a picture at all"), w.token, "image/png")).status).toBe(415);
    expect((await upload(w, w.agent.id, png(20, 20))).status).toBe(422);
    expect((await upload(w, w.agent.id, Buffer.concat([png(), Buffer.alloc(AVATAR_MAX_BYTES)]))).status).toBe(413);
    const noFile = await w.http.call("POST", `/api/agents/${w.agent.id}/avatar`, { token: w.token, form: new FormData() });
    expect(noFile.status).toBe(422);
    const agentMember = await addMemberRaw(w.ctx, w.wsId, { name: "Ann Agent", role: "agent" });
    expect((await upload(w, w.agent.id, png(), await tokenFor(w.ctx, agentMember))).status).toBe(403);
    expect((await w.http.call("DELETE", `/api/agents/${w.agent.id}/avatar`, { token: await tokenFor(w.ctx, agentMember) })).status).toBe(403);
    expect((await w.http.get(`/api/agents/${w.agent.id}`, w.token)).body.avatar_uploaded).toBe(false);
  });

  it("another workspace's manager cannot set or remove it (404), and an unknown or picture-less agent has no public picture", async () => {
    const w = await agentWorld();
    const other = await seedWorkspace(w.ctx, "Other");
    const t = await tokenFor(w.ctx, other.owner);
    expect((await upload(w, w.agent.id, png(), t)).status).toBe(404);
    expect((await w.http.call("DELETE", `/api/agents/${w.agent.id}/avatar`, { token: t })).status).toBe(404);
    expect((await w.app.request(`/avatars/agent/${w.agent.id}`)).status).toBe(404);
    expect((await w.app.request("/avatars/agent/agt_nope")).status).toBe(404);
  });

  it("replacing, pointing the picture elsewhere, removing and deleting the agent each remove the stored file", async () => {
    const w = await agentWorld();
    const keyOf = async () => (await w.ctx.db.get<{ avatar_key: string | null }>("SELECT avatar_key FROM ai_agents WHERE id = ?", w.agent.id))!.avatar_key;
    await upload(w, w.agent.id, png(100, 100));
    const k1 = (await keyOf())!;
    expect(await w.ctx.storage.read(k1)).not.toBeNull();
    await upload(w, w.agent.id, png(120, 120));
    const k2 = (await keyOf())!;
    expect(k2).not.toBe(k1);
    expect(await w.ctx.storage.read(k1)).toBeNull();
    // the form sends the unchanged address back: the upload stays
    const same = (await w.http.get(`/api/agents/${w.agent.id}`, w.token)).body;
    await w.http.patch(`/api/agents/${w.agent.id}`, { avatar_url: same.avatar_url, name: "Aria 2" }, w.token);
    expect(await keyOf()).toBe(k2);
    // a link elsewhere replaces it
    const ext = await w.http.patch(`/api/agents/${w.agent.id}`, { avatar_url: "https://pictures.example.test/aria.png" }, w.token);
    expect(ext.body).toMatchObject({ avatar_url: "https://pictures.example.test/aria.png", avatar_uploaded: false });
    expect(await w.ctx.storage.read(k2)).toBeNull();
    expect((await w.app.request(`/avatars/agent/${w.agent.id}`)).status).toBe(404);
    await upload(w, w.agent.id, png(100, 100));
    const k3 = (await keyOf())!;
    const rm = await w.http.call("DELETE", `/api/agents/${w.agent.id}/avatar`, { token: w.token });
    expect(rm.body).toMatchObject({ avatar_url: null, avatar_uploaded: false, avatar_alt: "" });
    expect(await w.ctx.storage.read(k3)).toBeNull();
    await upload(w, w.agent.id, png(100, 100));
    const k4 = (await keyOf())!;
    await w.http.call("DELETE", `/api/agents/${w.agent.id}`, { token: w.token });
    expect(await w.ctx.storage.read(k4)).toBeNull();
  });
});

describe("the built-in presets and their bundled portraits", () => {
  it("lists Aria and vb with a disclosure label each; only the two bundled files are served, with safe headers", async () => {
    const w = await agentWorld();
    const r = await w.http.get("/api/agents/presets", w.token);
    expect(r.status).toBe(200);
    expect(r.body.data.map((p: { key: string }) => p.key)).toEqual(["aria", "vb"]);
    for (const p of r.body.data) {
      expect(p.disclosure_label).toBe("AI assistant");
      expect(p.avatar_alt.length).toBeGreaterThan(10);
      const img = await w.app.request(p.avatar_url);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/webp");
      expect(img.headers.get("x-content-type-options")).toBe("nosniff");
      expect(img.headers.get("cache-control")).toMatch(/max-age=\d{6,}/);
      expect(img.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(Buffer.from(await img.arrayBuffer()).subarray(8, 12).toString("latin1")).toBe("WEBP");
    }
    for (const bad of ["/avatars/secret.webp", "/avatars/..%2Fwidget.js", "/avatars/aria.png", "/avatars/ARIA.webp"]) expect((await w.app.request(bad)).status, bad).toBe(404);
    const agentMember = await addMemberRaw(w.ctx, w.wsId, { name: "Ann Agent", role: "agent" });
    expect((await w.http.get("/api/agents/presets", await tokenFor(w.ctx, agentMember))).status).toBe(403);
  });

  it("a preset can be saved as an agent, its portrait path is accepted but arbitrary paths and hosts are not", async () => {
    const w = await agentWorld();
    const preset = (await w.http.get("/api/agents/presets", w.token)).body.data[0];
    const { key: _k, tagline: _t, ...body } = preset;
    const made = await w.http.post("/api/agents", { ...body, name: "Aria 2", enabled: false }, w.token);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ avatar_url: "/avatars/aria.webp", avatar_uploaded: false, disclosure_label: "AI assistant" });
    for (const bad of ["/avatars/other.webp", "/etc/passwd", "//evil.example.test/a.webp", "javascript:alert(1)", "/avatars/aria.webp?x=1"]) {
      expect((await w.http.patch(`/api/agents/${made.body.id}`, { avatar_url: bad }, w.token)).status, bad).toBe(400);
    }
  });

  it("a patch changes only what it names (persona, hours, picture and label survive a patch of one field)", async () => {
    const w = await agentWorld({ agent: { persona: "A very particular persona.", greeting: "Hello from the test", tone: "concise" } });
    const r = await w.http.patch(`/api/agents/${w.agent.id}`, { enabled: false }, w.token);
    expect(r.body).toMatchObject({ enabled: false, persona: "A very particular persona.", greeting: "Hello from the test", tone: "concise" });
  });
});

describe("the presets in the web app and on the server", () => {
  it("are the same data", async () => {
    const path = decodeURIComponent(new URL("../../web/src/api/agentPresets.ts", import.meta.url).pathname); // a variable: the server's compiler does not own the web app's files
    const web = (await import(/* @vite-ignore */ path)) as { AGENT_PRESETS: unknown };
    expect(web.AGENT_PRESETS).toEqual(AGENT_PRESETS);
  });
});
