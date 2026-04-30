/**
 * Sync Zone static UI from src/ui to dist/ui after tsc.
 * Always copies the full tree, then explicitly overwrites dist/ui/index.html
 * from src/ui/index.html so the shell entry is never stale.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const srcDir = path.join(root, "src", "ui");
const distDir = path.join(root, "dist", "ui");
const srcIndex = path.join(srcDir, "index.html");
const distIndex = path.join(distDir, "index.html");

if (!fs.existsSync(srcIndex)) {
  console.error("[zone-build] Missing UI source:", srcIndex);
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });
fs.cpSync(srcDir, distDir, { recursive: true, force: true });
fs.copyFileSync(srcIndex, distIndex);

const bytes = fs.statSync(distIndex).size;
console.log("[zone-build] UI synced →", distIndex, `(${bytes} bytes)`);
