const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const iconsDir = path.join(root, "build", "icons");
const iconsetDir = path.join(root, "build", "MovieCastBrowser.iconset");
const svgPath = path.join(root, "build", "icon.svg");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="160" y1="80" x2="864" y2="944" gradientUnits="userSpaceOnUse">
      <stop stop-color="#111820"/>
      <stop offset="1" stop-color="#060A0D"/>
    </linearGradient>
    <linearGradient id="accent" x1="224" y1="190" x2="820" y2="832" gradientUnits="userSpaceOnUse">
      <stop stop-color="#38E0C8"/>
      <stop offset="1" stop-color="#20B9A5"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="210" fill="url(#bg)"/>
  <rect x="128" y="128" width="768" height="768" rx="170" fill="#0D141A" stroke="#20303B" stroke-width="28"/>
  <path d="M252 618c90 0 164 74 164 164" fill="none" stroke="url(#accent)" stroke-width="76" stroke-linecap="round"/>
  <path d="M252 462c176 0 320 144 320 320" fill="none" stroke="url(#accent)" stroke-width="76" stroke-linecap="round"/>
  <path d="M252 306c262 0 476 214 476 476" fill="none" stroke="url(#accent)" stroke-width="76" stroke-linecap="round"/>
  <rect x="348" y="226" width="392" height="258" rx="46" fill="#EAF1F7"/>
  <rect x="402" y="284" width="284" height="142" rx="20" fill="#101820"/>
  <path d="M502 326v60l62-30-62-30z" fill="#38E0C8"/>
  <rect x="476" y="518" width="136" height="42" rx="21" fill="#EAF1F7"/>
</svg>
`;

const pngSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const iconsetSizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"]
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function writeIco(entries, outputPath) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let imageOffset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const data = fs.readFileSync(entry.path);
    const offset = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, offset);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, offset + 1);
    directory.writeUInt8(0, offset + 2);
    directory.writeUInt8(0, offset + 3);
    directory.writeUInt16LE(1, offset + 4);
    directory.writeUInt16LE(32, offset + 6);
    directory.writeUInt32LE(data.length, offset + 8);
    directory.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += data.length;
  });

  const images = entries.map((entry) => fs.readFileSync(entry.path));
  fs.writeFileSync(outputPath, Buffer.concat([header, directory, ...images]));
}

fs.mkdirSync(iconsDir, { recursive: true });
fs.rmSync(iconsetDir, { recursive: true, force: true });
fs.mkdirSync(iconsetDir, { recursive: true });
fs.writeFileSync(svgPath, svg);

for (const size of pngSizes) {
  run("sips", ["-s", "format", "png", "-z", String(size), String(size), svgPath, "--out", path.join(iconsDir, `icon-${size}.png`)]);
}

for (const [size, filename] of iconsetSizes) {
  run("sips", ["-s", "format", "png", "-z", String(size), String(size), svgPath, "--out", path.join(iconsetDir, filename)]);
}

run("iconutil", ["-c", "icns", iconsetDir, "-o", path.join(iconsDir, "icon.icns")]);
fs.copyFileSync(path.join(iconsDir, "icon-1024.png"), path.join(iconsDir, "icon.png"));
writeIco(
  [16, 32, 48, 64, 128, 256].map((size) => ({
    size,
    path: path.join(iconsDir, `icon-${size}.png`)
  })),
  path.join(iconsDir, "icon.ico")
);
fs.rmSync(iconsetDir, { recursive: true, force: true });

console.log(`Generated icons in ${path.relative(root, iconsDir)}`);
