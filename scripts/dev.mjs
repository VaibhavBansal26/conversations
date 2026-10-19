// Runs the API (tsx watch, :3000) and the web dev server (vite, :5173) together with prefixed output.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const procs = [
  ["server", ["run", "dev", "--prefix", resolve(root, "server")]],
  ["web", ["run", "dev", "--prefix", resolve(root, "web")]],
].map(([name, args]) => {
  const p = spawn("npm", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const tag = (chunk) => String(chunk).split("\n").filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code) => {
    console.log(`[${name}] exited with ${code}`);
    stop();
  });
  return p;
});
function stop() {
  for (const p of procs) p.kill("SIGTERM");
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
