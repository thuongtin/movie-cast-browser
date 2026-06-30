const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const electronRoot = path.join(root, "node_modules", "electron");
const installScript = path.join(electronRoot, "install.js");
const cacheRoot = path.join(root, ".electron-cache");

function getPlatformPath() {
  switch (os.platform()) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
    case "freebsd":
    case "openbsd":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Unsupported Electron platform: ${os.platform()}`);
  }
}

function electronPath() {
  return path.join(electronRoot, "dist", getPlatformPath());
}

function isReady() {
  return fs.existsSync(electronPath());
}

function runInstallScript() {
  if (!fs.existsSync(installScript)) {
    throw new Error("Electron install script is missing. Run npm install first.");
  }

  const result = spawnSync(process.execPath, [installScript], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      force_no_cache: "true",
      electron_config_cache: cacheRoot
    }
  });

  if (result.status !== 0) {
    throw new Error("Electron binary install failed.");
  }
}

function findElectronZip(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findElectronZip(fullPath);
      if (found) return found;
    } else if (/electron-v.+\.(zip|tar\.gz)$/i.test(entry.name)) {
      return fullPath;
    }
  }
  return null;
}

function extractCachedZip() {
  const zipPath = findElectronZip(cacheRoot);
  if (!zipPath) return false;

  fs.mkdirSync(path.join(electronRoot, "dist"), { recursive: true });
  const result = spawnSync("unzip", ["-oq", zipPath, "-d", path.join(electronRoot, "dist")], {
    cwd: root,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    return false;
  }

  fs.writeFileSync(path.join(electronRoot, "path.txt"), getPlatformPath());
  return isReady();
}

if (!isReady()) {
  runInstallScript();
}

if (!isReady() && !extractCachedZip()) {
  throw new Error("Electron binary is still missing after install.");
}

console.log(`Electron ready: ${electronPath()}`);
