// Loads the frontend source the way the browser does: app.js, then every
// <script src="js/..."> from index.html, in order. The app is a set of classic
// scripts sharing one global scope, so tests that extract functions by name
// search this concatenation rather than a single file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "static");
const html = readFileSync(join(root, "index.html"), "utf8");
export const scriptPaths = [...html.matchAll(/<script src="((?:app|js\/[\w-]+)\.js)"/g)].map(m => m[1]);

export function loadAppSource() {
  if (!scriptPaths.length) throw new Error("no app scripts found in index.html");
  return scriptPaths.map(p => readFileSync(join(root, p), "utf8")).join("\n");
}
