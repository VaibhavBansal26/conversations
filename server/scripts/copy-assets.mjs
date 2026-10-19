import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(resolve(root, "dist/db"), { recursive: true });
cpSync(resolve(root, "src/db/migrations"), resolve(root, "dist/db/migrations"), { recursive: true });
