import sharp from "sharp";
import { fileURLToPath } from "node:url";

const icon = Buffer.from(String.raw`
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#0b1f36"/>
  <path d="M256 66 408 126v119c0 103-60 184-152 226-92-42-152-123-152-226V126L256 66Z" fill="#60a5fa"/>
  <path d="M256 111 368 155v90c0 78-43 140-112 176-69-36-112-98-112-176v-90L256 111Z" fill="#0b1f36"/>
  <rect x="171" y="203" width="170" height="116" rx="45" fill="#ffffff"/>
  <rect x="191" y="177" width="18" height="43" rx="9" fill="#60a5fa"/>
  <rect x="303" y="177" width="18" height="43" rx="9" fill="#60a5fa"/>
  <circle cx="218" cy="252" r="13" fill="#2563eb"/>
  <circle cx="294" cy="252" r="13" fill="#2563eb"/>
  <path d="M215 284c12 15 26 22 41 22s29-7 41-22" fill="none" stroke="#2563eb" stroke-width="13" stroke-linecap="round"/>
</svg>`);

const outputs = [
  { size: 192, filename: "icon-192.png" },
  { size: 512, filename: "icon-512.png" },
  { size: 192, filename: "icon-192-blue-v1.png" },
  { size: 512, filename: "icon-512-blue-v1.png" },
];

for (const { size, filename } of outputs) {
  const output = new URL(`../public/icons/${filename}`, import.meta.url);
  await sharp(icon)
    .resize(size, size)
    .png({ compressionLevel: 9, palette: true })
    .toFile(fileURLToPath(output));
  console.log(`Generated ${output.pathname}`);
}
