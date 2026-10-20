// Operator CLI for platform admins (there is deliberately no HTTP endpoint that creates one). Uses the same database as the server.
//   ADMIN_EMAIL=ops@example.com ADMIN_NAME="Ops" npx tsx scripts/platform-admin.ts create [--role superadmin|support]
//       ADMIN_PASSWORD may be set (min 12 chars); when it is not, a random one is generated and printed ONCE.
//   npx tsx scripts/platform-admin.ts reset-mfa --email ops@example.com     (lost authenticator: the admin enrols again at next sign-in)
//   npx tsx scripts/platform-admin.ts list
import { randomBytes } from "node:crypto";
import { closeContext, createContext } from "../src/app-context.js";
import { createPlatformAdmin, type AdminRole } from "../src/admin/auth.js";
import { loadConfig } from "../src/config.js";
import { recordAudit } from "../src/services/audit.js";
import { silentLogger } from "../src/logger.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const ctx = await createContext(loadConfig(), { log: silentLogger });
try {
  if (cmd === "create") {
    const email = process.env.ADMIN_EMAIL;
    if (!email) throw new Error("Set ADMIN_EMAIL (and optionally ADMIN_NAME, ADMIN_PASSWORD)");
    const role = (flag("role") ?? "superadmin") as AdminRole;
    if (role !== "superadmin" && role !== "support") throw new Error("--role must be superadmin or support");
    const generated = !process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD ?? randomBytes(15).toString("base64url");
    const a = await createPlatformAdmin(ctx, { email, name: process.env.ADMIN_NAME ?? email.split("@")[0]!, password, role });
    console.log(`Created ${a.role} ${a.email} (${a.id}).`);
    if (generated) console.log(`One-time password (shown once; store it in a password manager): ${password}`);
    console.log("At first sign-in the admin must enrol an authenticator app; nothing is reachable before that.");
  } else if (cmd === "reset-mfa") {
    const email = flag("email");
    if (!email) throw new Error("--email is required");
    const r = await ctx.db.run("UPDATE platform_admins SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE email = ?", email.toLowerCase());
    if (!r.changes) throw new Error("No such admin");
    await recordAudit(ctx, { actor: { type: "system" }, action: "admin.mfa_reset", target: email.toLowerCase(), detail: { via: "cli" } });
    console.log("Two-factor reset. The admin must enrol again at next sign-in.");
  } else if (cmd === "list") {
    for (const a of await ctx.db.all<{ email: string; role: string; totp_enabled_at: string | null; disabled_at: string | null }>("SELECT email, role, totp_enabled_at, disabled_at FROM platform_admins ORDER BY created_at"))
      console.log(`${a.email}\t${a.role}\tmfa=${a.totp_enabled_at ? "yes" : "no"}\t${a.disabled_at ? "DISABLED" : "active"}`);
  } else {
    console.error("Usage: platform-admin.ts create|reset-mfa|list");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await closeContext(ctx);
}
