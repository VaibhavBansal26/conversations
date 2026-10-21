import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signIdentity } from "../src/services/identity.js";
import { startServer } from "./rt-helpers.js";

/**
 * The examples in docs/MOBILE-BRIDGE.md and docs/MOBILE-API.md are exercised, so a renamed field or a wrong snippet fails the build:
 * the identity-signing snippets are run in every interpreter that exists here, the curl flow is replayed against a real HTTP server, the TypeScript
 * example is type-checked against the real socket.io-client types and the Swift example with swiftc. Kotlin and the Swift socket snippet are NOT
 * compiled (no toolchain / no package access); the documents say so.
 */
const doc = (n: string) => readFileSync(new URL(`../../docs/${n}`, import.meta.url), "utf8");
const have = (cmd: string, arg = "--version") => spawnSync(cmd, [arg], { encoding: "utf8" }).status === 0;
const block = (md: string, lang: string, marker: string) => [...md.matchAll(new RegExp("```" + lang + " " + marker + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]!);
const VECTOR = signIdentity("secret-for-docs", "u_42", "ana@example.com");

describe("docs/MOBILE-BRIDGE.md identity snippets print the reference vector", () => {
  const md = doc("MOBILE-BRIDGE.md");
  const dir = mkdtempSync(join(tmpdir(), "conv-snip-"));
  const run = (lang: string, ext: string, cmd: string, args: string[] = []) => {
    const src = block(md, lang, "identity-snippet");
    expect(src.length, `${lang} snippet present`).toBe(1);
    const file = join(dir, `snippet.${ext}`);
    writeFileSync(file, src[0]!);
    const r = spawnSync(cmd, [...args, file], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe(VECTOR);
  };
  it("the vector in the table is what the server computes", () => {
    expect(md).toContain(VECTOR);
  });
  it("node", () => run("js", "mjs", process.execPath));
  it.skipIf(!have("python3"))("python", () => run("python", "py", "python3", ["-I"]));
  it.skipIf(!have("ruby"))("ruby", () => run("ruby", "rb", "ruby"));
  it.skipIf(!have("php"))("php (skipped when php is not installed: not verified on this machine)", () => run("php", "php", "php"));
  it("cleans up", () => rmSync(dir, { recursive: true, force: true }));
});

describe("docs/MOBILE-API.md", () => {
  const md = doc("MOBILE-API.md");

  it("the curl flow works as written, against a real HTTP server", async () => {
    const srv = await startServer();
    try {
      const { wsId } = await srv.seedWorkspace(srv.ctx, "Acme");
      const owner = (await srv.ctx.db.get<{ id: string }>("SELECT id FROM members WHERE workspace_id = ?", wsId))!;
      const { createToken } = await import("../src/services/visitors.js");
      const { actorFromRow, getMember } = await import("../src/services/members.js");
      const tok = await createToken(srv.ctx, actorFromRow(await getMember(srv.ctx, wsId, owner.id)), "app.example.com", { hosted_chat_enabled: true });

      const flow = md.match(/```bash\nBASE=[\s\S]*?```/)![0];
      // headers and bodies come from the document
      expect(flow).toContain('-H "x-hosted-chat: 1"');
      expect(flow).toContain('-H "x-api-key: $KEY"');
      expect(flow).toContain('-H "x-device-id: $DEV"');
      expect(flow).toContain('-H "x-support-session: $SES"');
      const dev = flow.match(/^DEV=(\S+)/m)![1]!;
      const bodies = [...flow.matchAll(/-d '(\{[^']*\})'/g)].map((m) => JSON.parse(m[1]!));
      expect(bodies).toHaveLength(3);
      const paths = [...flow.matchAll(/\$BASE(\/public\/[^\s"]*)"/g)].map((m) => m[1]!);
      expect(paths).toEqual(["/public/widget/config", "/public/sessions", "/public/rooms", "/public/rooms/$ROOM/messages", "/public/rooms/$ROOM/messages?limit=30"]);

      const base = srv.url;
      const call = async (method: string, path: string, session?: string, body?: unknown) => {
        const res = await fetch(base + path, {
          method,
          headers: { "x-api-key": tok.token, "x-hosted-chat": "1", "x-device-id": dev, ...(session ? { "x-support-session": session } : {}), ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: (await res.json()) as any };
      };
      const cfg = await call("GET", "/public/widget/config");
      expect(cfg.status).toBe(200);
      expect(cfg.body).toHaveProperty("widget.title");
      const ses = await call("POST", "/public/sessions", undefined, bodies[0]);
      expect(ses.status).toBe(201);
      expect(Object.keys(ses.body)).toEqual(expect.arrayContaining(["session_id", "session_token", "workspace_id", "verified", "expires_at", "contact", "requires_verification"]));
      expect(ses.body.session_token).toMatch(/^ses_/);
      const room = await call("POST", "/public/rooms", ses.body.session_token, bodies[1]);
      expect(room.status).toBe(201);
      expect(room.body.created).toBe(true);
      expect(Object.keys(room.body.room)).toEqual(expect.arrayContaining(["id", "status", "unread_count", "last_message"]));
      const first = await call("POST", `/public/rooms/${room.body.room.id}/messages`, ses.body.session_token, bodies[2]);
      const again = await call("POST", `/public/rooms/${room.body.room.id}/messages`, ses.body.session_token, bodies[2]);
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(again.body.id).toBe(first.body.id);
      const hist = await call("GET", `/public/rooms/${room.body.room.id}/messages?limit=30`, ses.body.session_token);
      expect(hist.body.pagination).toHaveProperty("before_cursor");
      expect(hist.body.data.filter((m: { content_text: string }) => m.content_text === "Hello, my order is late")).toHaveLength(1);
      // a request without the marker and without an Origin is refused: the doc's claim
      const bare = await fetch(base + "/public/widget/config", { headers: { "x-api-key": tok.token } });
      expect(bare.status).toBe(403);
    } finally {
      await srv.close();
    }
  });

  it("the TypeScript example type-checks against the real socket.io-client types", () => {
    const src = block(md, "ts", "mobile-api");
    expect(src).toHaveLength(1);
    const server = fileURLToPath(new URL("..", import.meta.url));
    const dir = mkdtempSync(join(server, ".docs-ts-"));
    try {
      writeFileSync(join(dir, "example.ts"), src[0]!);
      const r = spawnSync(join(server, "node_modules/.bin/tsc"), ["--noEmit", "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--lib", "ES2022,DOM", "--types", "node", join(dir, "example.ts")], { cwd: server, encoding: "utf8" });
      expect(r.stdout + r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!have("swiftc"))("the Swift URLSession example type-checks with swiftc (the socket.io-client-swift snippet is not compiled)", () => {
    const src = block(md, "swift", "mobile-api");
    expect(src).toHaveLength(1);
    const dir = mkdtempSync(join(tmpdir(), "conv-swift-"));
    try {
      writeFileSync(join(dir, "Example.swift"), src[0]!);
      const r = spawnSync("swiftc", ["-typecheck", join(dir, "Example.swift")], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
