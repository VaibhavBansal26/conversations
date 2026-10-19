import { describe, expect, it } from "vitest";
import { sanitizeFileName, sniff, saveUpload } from "../src/services/attachments.js";
import { sendAgentMessage } from "../src/services/messages.js";
import { fullApp, mkRoom, seedWorkspace, tokenFor } from "./helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const GIF = Buffer.from("GIF89a" + "\0".repeat(20), "latin1");
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 3)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 4)]);

describe("magic-byte sniffing", () => {
  const cases: [string, Buffer, string | null][] = [
    ["png", PNG, "image/png"],
    ["jpeg", JPG, "image/jpeg"],
    ["pdf", PDF, "application/pdf"],
    ["gif", GIF, "image/gif"],
    ["webm audio", WEBM, "audio/webm"],
    ["plain text", Buffer.from("hello, café"), "text/plain"],
    ["exe", EXE, null],
    ["svg (xss vector)", SVG, "text/plain"],
    ["binary garbage", Buffer.from([0, 1, 2, 3, 4, 5]), null],
    ["tiny text", Buffer.from("ab"), "text/plain"],
    ["empty", Buffer.alloc(0), null],
  ];
  it.each(cases)("%s", (_n, buf, mime) => expect(sniff(buf)?.mime ?? null).toBe(mime));
});

describe("file name sanitising", () => {
  const cases: [string, string][] = [
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32\\cmd.exe", "cmd.exe"],
    ["/abs/path/photo.png", "photo.png"],
    ["we ird\u0000na\u0007me.png", "we irdname.png"],
    ['a"b<c>d:e|f?g*.txt', "abcdefg.txt"],
    ["....hidden", "hidden"],
    ["   ", "file"],
    ["", "file"],
    ["a".repeat(300) + ".png", "a".repeat(120)],
  ];
  it.each(cases)("%j -> %j", (input, out) => expect(sanitizeFileName(input)).toBe(out));
});

describe("upload rules", () => {
  async function up(name: string, content: Buffer) {
    const f = await fullApp();
    return { ...f, run: () => saveUpload(f.ctx, f.owner, { name, content }) };
  }
  it("accepts allowed types whose extension matches the contents", async () => {
    for (const [name, buf, type] of [
      ["photo.PNG", PNG, "image/png"],
      ["pic.jpeg", JPG, "image/jpeg"],
      ["doc.pdf", PDF, "application/pdf"],
      ["clip.webm", WEBM, "audio/webm"],
      ["notes.txt", Buffer.from("hi"), "text/plain"],
      ["data.csv", Buffer.from("a,b\n1,2"), "text/csv"],
      ["sheet.xlsx", ZIP, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ] as const) {
      const r = await (await up(name, buf)).run();
      expect(r.content_type, name).toBe(type);
    }
  });
  it("rejects spoofed extensions and spoofed contents", async () => {
    await expect((await up("evil.png", PDF)).run()).rejects.toMatchObject({ code: "FILE_TYPE_MISMATCH", status: 415 });
    await expect((await up("photo.jpg", PNG)).run()).rejects.toMatchObject({ code: "FILE_TYPE_MISMATCH" });
    await expect((await up("report.pdf", EXE)).run()).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    await expect((await up("virus.exe", EXE)).run()).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    await expect((await up("image.svg", SVG)).run()).rejects.toMatchObject({ code: "FILE_TYPE_MISMATCH" }); // svg is text to us, never an image
    await expect((await up("archive.zip", ZIP)).run()).rejects.toMatchObject({ code: "FILE_TYPE_MISMATCH" });
    await expect((await up("noext", PNG)).run()).rejects.toMatchObject({ code: "FILE_TYPE_MISMATCH" });
  });
  it("enforces the size limit and rejects empty files", async () => {
    const f = await fullApp({ UPLOAD_MAX_BYTES: "1000" });
    await expect(saveUpload(f.ctx, f.owner, { name: "a.txt", content: Buffer.alloc(1001, 97) })).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
    expect((await saveUpload(f.ctx, f.owner, { name: "a.txt", content: Buffer.alloc(1000, 97) })).size).toBe(1000);
    await expect(saveUpload(f.ctx, f.owner, { name: "a.txt", content: Buffer.alloc(0) })).rejects.toMatchObject({ code: "EMPTY_FILE" });
  });
  it("neutralises path traversal in the file name and never writes outside the workspace dir", async () => {
    const f = await fullApp();
    const att = await saveUpload(f.ctx, f.owner, { name: "../../../etc/passwd.txt", content: Buffer.from("x") });
    expect(att.file_name).toBe("passwd.txt");
    expect(att.key).toMatch(new RegExp(`^${f.wsId}/f_[0-9a-f]{24}$`));
  });
});

describe("attachments over HTTP", () => {
  const upload = (http: any, token: string, name: string, buf: Buffer, type = "application/octet-stream") => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(buf)], name, { type }));
    return http.call("POST", "/api/attachments", { token, form });
  };
  it("uploads, attaches to a message, and serves via a signed URL with safe headers", async () => {
    const { ctx, app, http, token, wsId } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const up = await upload(http, token, "my photo.png", PNG, "image/png");
    expect(up.status).toBe(201);
    const msg = await http.post(`/api/rooms/${room.id}/messages`, { kind: "image", source: "dm", attachment_ids: [up.body.id], client_msg_id: "attach-qid-001" }, token);
    expect(msg.status).toBe(201);
    expect(msg.body.attachments[0]).toMatchObject({ file_name: "my photo.png", content_type: "image/png", size: PNG.length });
    const u = new URL(msg.body.attachments[0].url);
    const res = await app.request(u.pathname + u.search);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''my%20photo.png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
  it("forces download for non-previewable types", async () => {
    const { app, http, token } = await fullApp();
    const up = await upload(http, token, "notes.txt", Buffer.from("secret"), "text/plain");
    const u = new URL(up.body.url);
    expect((await app.request(u.pathname + u.search)).headers.get("content-disposition")).toMatch(/^attachment;/);
  });
  it("rejects expired, tampered and foreign-key signed URLs", async () => {
    const { ctx, app, http, token } = await fullApp();
    const up = await upload(http, token, "a.png", PNG);
    const u = new URL(up.body.url);
    const path = u.pathname + u.search;
    expect((await app.request(path)).status).toBe(200);
    expect((await app.request(path.replace(/sig=([0-9a-f])/, (_m, c) => `sig=${c === "0" ? "1" : "0"}`))).status).toBe(403);
    expect((await app.request(path.replace(/exp=\d+/, "exp=9999999999"))).status).toBe(403);
    expect((await app.request(u.pathname)).status).toBe(403);
    expect((await app.request(path.replace("/files/", "/files/../"))).status).toBeGreaterThanOrEqual(400);
    ctx.clockCtl.advance((ctx.config.SIGNED_URL_TTL_SECONDS + 5) * 1000);
    // the local storage reads the same clock, so the link has now expired
    expect((await app.request(path)).status).toBe(403);
  });
  it("rejects bad uploads with the error envelope and requires auth", async () => {
    const { http, token } = await fullApp();
    expect((await upload(http, token, "evil.png", PDF)).body.error.code).toBe("FILE_TYPE_MISMATCH");
    expect((await upload(http, token, "x.exe", EXE)).status).toBe(415);
    expect((await http.call("POST", "/api/attachments", { token, form: new FormData() })).body.error.code).toBe("FILE_REQUIRED");
    expect((await upload(http, "", "a.png", PNG)).status).toBe(401);
  });
  it("enforces the HTTP body limit on uploads", async () => {
    const { http, token } = await fullApp({ UPLOAD_MAX_BYTES: "2000" });
    const res = await upload(http, token, "big.txt", Buffer.alloc(200_000, 97));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
  });
  it("cannot attach another workspace's file, and attachment kinds/ids are validated", async () => {
    const { ctx, http, token, wsId } = await fullApp();
    const other = await seedWorkspace(ctx, "Other");
    const foreign = await upload(http, await tokenFor(ctx, other.owner), "a.png", PNG);
    const { room } = await mkRoom(ctx, wsId);
    expect((await http.post(`/api/rooms/${room.id}/messages`, { kind: "image", attachment_ids: [foreign.body.id] }, token)).body.error.code).toBe("UNKNOWN_ATTACHMENT");
    await expect(sendAgentMessage(ctx, (await fullApp()).owner, room.id, { kind: "image", source: "dm", attachment_ids: [] })).rejects.toBeTruthy();
  });
  it("voice notes (webm) and documents attach as their own kinds", async () => {
    const { ctx, http, token, wsId } = await fullApp();
    const { room } = await mkRoom(ctx, wsId);
    const voice = await upload(http, token, "voice.webm", WEBM, "audio/webm");
    const doc = await upload(http, token, "invoice.pdf", PDF, "application/pdf");
    expect((await http.post(`/api/rooms/${room.id}/messages`, { kind: "voice", attachment_ids: [voice.body.id] }, token)).body.kind).toBe("voice");
    const d = await http.post(`/api/rooms/${room.id}/messages`, { kind: "attachment", content: "Your invoice", attachment_ids: [doc.body.id] }, token);
    expect(d.body.attachments).toHaveLength(1);
  });
});
