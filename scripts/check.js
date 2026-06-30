const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const files = [
  "index.html",
  "vite.config.mjs",
  "tailwind.config.js",
  "postcss.config.js",
  "components.json",
  "electron-builder.yml",
  "jsconfig.json",
  "src/main.js",
  "src/preload.js",
  "src/webview-preload.js",
  "src/renderer/main.jsx",
  "src/renderer/App.jsx",
  "src/renderer/globals.css",
  "src/lib/utils.js",
  "src/components/ui/badge.jsx",
  "src/components/ui/button.jsx",
  "src/components/ui/card.jsx",
  "src/components/ui/input.jsx",
  "src/components/ui/separator.jsx",
  "src/components/ui/slider.jsx",
  "sample/sample.html",
  "scripts/generate-icons.js",
  "scripts/ensure-electron.js",
  "README.md",
  "package.json"
];

const jsFiles = files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));

for (const file of files) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
  const content = fs.readFileSync(fullPath, "utf8");
  if (content.includes("\u2014")) {
    throw new Error(`Em dash is not allowed: ${file}`);
  }
}

for (const file of jsFiles) {
  const fullPath = path.join(root, file);
  const result = spawnSync(process.execPath, ["--check", fullPath], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log("Checks passed");
