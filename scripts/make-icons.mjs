/* Rasterise the Float mark into every icon the app ships.
 *
 * The art lives in public/brand/*.svg so there is one source for the PWA
 * icons, the favicon and the in-app <AppLogo>. The maskable variant is the
 * same drawing shrunk into the middle 78% of the canvas, because Android
 * crops maskable icons to a circle and would otherwise cut the mast off.
 *
 *   node scripts/make-icons.mjs
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";

const any = readFileSync("public/brand/float-mark.svg");
const maskable = readFileSync("public/brand/float-mark-maskable.svg");

const targets = [
  [any, "public/icons/icon-192.png", 192],
  [any, "public/icons/icon-512.png", 512],
  [maskable, "public/icons/icon-maskable-192.png", 192],
  [maskable, "public/icons/icon-maskable-512.png", 512],
  [any, "public/apple-touch-icon.png", 180],
];

for (const [src, out, size] of targets) {
  await sharp(src, { density: 384 }).resize(size, size).png().toFile(out);
  console.log(`${out}  ${size}x${size}`);
}

// The favicon is an .ico by name but browsers have read PNG bytes there for
// well over a decade, and Next serves app/favicon.ico verbatim.
await sharp(any, { density: 384 }).resize(64, 64).png().toFile("app/favicon.ico");
console.log("app/favicon.ico  64x64");
