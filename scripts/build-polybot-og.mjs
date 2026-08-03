import sharp from "sharp";
import { fileURLToPath } from "node:url";

const width = 1200;
const height = 630;
const source = new URL(
  "../public/branding/goyang-polybot-scene-v3.png",
  import.meta.url,
);
const robot = new URL(
  "../public/branding/goyang-polybot-user-cutout-v1.png",
  import.meta.url,
);
const output = new URL("../public/og-goyang-polybot-v3.jpg", import.meta.url);

const overlay = String.raw`
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#04101f" stop-opacity="0.98"/>
      <stop offset="0.43" stop-color="#06182a" stop-opacity="0.88"/>
      <stop offset="0.66" stop-color="#071a2b" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#071a2b" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="badge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#143b52"/>
      <stop offset="1" stop-color="#0a2638"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000814" flood-opacity="0.42"/>
    </filter>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#shade)"/>
  <rect x="58" y="54" width="330" height="42" rx="21" fill="url(#badge)" stroke="#48d7f2" stroke-opacity="0.55"/>
  <circle cx="82" cy="75" r="7" fill="#f4cb45"/>
  <circle cx="82" cy="75" r="13" fill="none" stroke="#f4cb45" stroke-opacity="0.32"/>
  <text x="105" y="82" fill="#dff7ff" font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" font-size="18" font-weight="700" letter-spacing="1.1">GOYANG POLYBOT · SAFEBOT</text>

  <g filter="url(#shadow)">
    <text x="58" y="183" fill="#ffffff" font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" font-size="46" font-weight="700" letter-spacing="-1.5">AI 감지 기능을 탑재한</text>
    <text x="56" y="270" fill="#f4cb45" font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" font-size="76" font-weight="800" letter-spacing="-3">고양 폴리봇</text>
  </g>

  <rect x="58" y="305" width="56" height="5" rx="2.5" fill="#4bd4f1"/>
  <rect x="120" y="305" width="18" height="5" rx="2.5" fill="#f4cb45"/>
  <text x="58" y="354" fill="#e4eef5" font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" font-size="25" font-weight="600" letter-spacing="-0.7">현장 감지부터 관제 알림까지</text>
  <text x="58" y="392" fill="#9fb7c7" font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" font-size="19" font-weight="500" letter-spacing="-0.35">모바일 카메라로 먼저 검증하는 주민안전 AI 관제 프로토타입</text>

  <g font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" font-size="16" font-weight="700">
    <rect x="58" y="439" width="148" height="43" rx="21.5" fill="#102b3c" stroke="#456376"/>
    <circle cx="82" cy="460.5" r="5" fill="#ef4857"/>
    <text x="96" y="467" fill="#f4f8fb">사람·사물 감지</text>

    <rect x="216" y="439" width="166" height="43" rx="21.5" fill="#102b3c" stroke="#456376"/>
    <circle cx="240" cy="460.5" r="5" fill="#f4cb45"/>
    <text x="254" y="467" fill="#f4f8fb">쓰러짐 10초 확인</text>

    <rect x="392" y="439" width="154" height="43" rx="21.5" fill="#102b3c" stroke="#456376"/>
    <circle cx="416" cy="460.5" r="5" fill="#4bd4f1"/>
    <text x="430" y="467" fill="#f4f8fb">얼굴 비식별화</text>
  </g>

  <text x="58" y="565" fill="#6f8a9d" font-family="Apple SD Gothic Neo, AppleGothic, sans-serif" font-size="15" font-weight="700" letter-spacing="1.4">PHYSICAL AI · LIVE CONTROL · FIELD PROTOTYPE</text>
</svg>`;

const robotWidth = 430;
const robotBuffer = await sharp(fileURLToPath(robot))
  .resize({ width: robotWidth, withoutEnlargement: true })
  .png()
  .toBuffer();

const groundShadow = Buffer.from(String.raw`
<svg width="480" height="90" viewBox="0 0 480 90" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="blur" x="-20%" y="-60%" width="140%" height="220%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
  </defs>
  <ellipse cx="240" cy="48" rx="205" ry="24" fill="#020914" fill-opacity="0.7" filter="url(#blur)"/>
</svg>`);

await sharp(fileURLToPath(source))
  .resize(width, height, { fit: "cover", position: "center" })
  .composite([
    { input: groundShadow, left: 715, top: 530 },
    { input: robotBuffer, left: 755, top: 106 },
    { input: Buffer.from(overlay) },
  ])
  .jpeg({ quality: 88, chromaSubsampling: "4:4:4", mozjpeg: true })
  .toFile(fileURLToPath(output));

console.log(`Generated ${output.pathname}`);
