import sharp from "sharp";

const [, , sourcePath, outputPath] = process.argv;

if (!sourcePath || !outputPath) {
  throw new Error(
    "Usage: node scripts/extract-user-polybot.mjs <source-image> <output-png>",
  );
}

// Coordinates isolate the user-owned robot artwork from the supplied story image.
const crop = { left: 130, top: 445, width: 455, height: 550 };
const background = [156, 156, 156];
const backgroundTolerance = 32;
const footerStartY = 531;

const { data, info } = await sharp(sourcePath)
  .extract(crop)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const pixelCount = info.width * info.height;
const isBackground = new Uint8Array(pixelCount);
const queued = new Uint8Array(pixelCount);
const queue = new Int32Array(pixelCount);
let queueStart = 0;
let queueEnd = 0;

function isFlatStoryBackground(index) {
  const offset = index * info.channels;
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  const maxDifference = Math.max(
    Math.abs(r - background[0]),
    Math.abs(g - background[1]),
    Math.abs(b - background[2]),
  );
  const channelSpread = Math.max(r, g, b) - Math.min(r, g, b);
  return maxDifference <= backgroundTolerance && channelSpread <= 18;
}

function enqueue(index) {
  if (queued[index] || !isFlatStoryBackground(index)) return;
  queued[index] = 1;
  queue[queueEnd++] = index;
}

for (let x = 0; x < info.width; x += 1) {
  enqueue(x);
  enqueue((info.height - 1) * info.width + x);
}
for (let y = 0; y < info.height; y += 1) {
  enqueue(y * info.width);
  enqueue(y * info.width + info.width - 1);
}

while (queueStart < queueEnd) {
  const index = queue[queueStart++];
  isBackground[index] = 1;
  const x = index % info.width;
  const y = Math.floor(index / info.width);
  if (x > 0) enqueue(index - 1);
  if (x + 1 < info.width) enqueue(index + 1);
  if (y > 0) enqueue(index - info.width);
  if (y + 1 < info.height) enqueue(index + info.width);
}

const protectedPolygons = [
  [
    [28, 55],
    [398, 55],
    [425, 285],
    [385, 325],
    [330, 360],
    [62, 345],
    [22, 305],
  ],
];

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function isProtectedRobotInterior(x, y) {
  return protectedPolygons.some((polygon) => pointInPolygon(x, y, polygon));
}

// Remove isolated JPEG-gray pixels too, while protecting the robot's neutral
// body panels from being mistaken for the story background.
for (let index = 0; index < pixelCount; index += 1) {
  const x = index % info.width;
  const y = Math.floor(index / info.width);
  if (isProtectedRobotInterior(x, y)) {
    isBackground[index] = 0;
  } else if (isFlatStoryBackground(index)) {
    isBackground[index] = 1;
  }
}

// The story footer touches the screenshot edge; remove it before component analysis.
for (let y = footerStartY; y < info.height; y += 1) {
  for (let x = 0; x < info.width; x += 1) {
    isBackground[y * info.width + x] = 1;
  }
}

// Remove only the bright neutral pixels of the separate city caption below the
// robot. Dark undercarriage pixels in the same area remain untouched.
for (let y = 455; y < 531; y += 1) {
  for (let x = 75; x < 260; x += 1) {
    const index = y * info.width + x;
    const offset = index * info.channels;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const average = (r + g + b) / 3;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (average >= 165 && spread <= 16) isBackground[index] = 1;
  }
}

// Clear the darker JPEG-gray visible through the gap below the top sensor arm.
// The sensor and roof are either dark or bright, so their source pixels remain.
for (let y = 0; y < 55; y += 1) {
  for (let x = 0; x < info.width; x += 1) {
    const index = y * info.width + x;
    const offset = index * info.channels;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const average = (r + g + b) / 3;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (average >= 90 && average <= 185 && spread <= 18) {
      isBackground[index] = 1;
    }
  }
}

const visited = new Uint8Array(pixelCount);
let largestComponent = [];
const componentQueue = new Int32Array(pixelCount);

for (let start = 0; start < pixelCount; start += 1) {
  if (isBackground[start] || visited[start]) continue;

  let componentStart = 0;
  let componentEnd = 0;
  const component = [];
  componentQueue[componentEnd++] = start;
  visited[start] = 1;

  while (componentStart < componentEnd) {
    const index = componentQueue[componentStart++];
    component.push(index);
    const x = index % info.width;
    const y = Math.floor(index / info.width);

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nextX = x + dx;
        const nextY = y + dy;
        if (
          nextX < 0 ||
          nextX >= info.width ||
          nextY < 0 ||
          nextY >= info.height
        ) {
          continue;
        }
        const next = nextY * info.width + nextX;
        if (!isBackground[next] && !visited[next]) {
          visited[next] = 1;
          componentQueue[componentEnd++] = next;
        }
      }
    }
  }

  if (component.length > largestComponent.length) {
    largestComponent = component;
  }
}

if (largestComponent.length < 50_000) {
  throw new Error("Could not isolate a sufficiently large robot component");
}

const keep = new Uint8Array(pixelCount);
let minX = info.width;
let minY = info.height;
let maxX = 0;
let maxY = 0;

for (const index of largestComponent) {
  keep[index] = 1;
  const x = index % info.width;
  const y = Math.floor(index / info.width);
  minX = Math.min(minX, x);
  minY = Math.min(minY, y);
  maxX = Math.max(maxX, x);
  maxY = Math.max(maxY, y);
}

const padding = 4;
minX = Math.max(0, minX - padding);
minY = Math.max(0, minY - padding);
maxX = Math.min(info.width - 1, maxX + padding);
maxY = Math.min(info.height - 1, maxY + padding);

const outputWidth = maxX - minX + 1;
const outputHeight = maxY - minY + 1;
const rgba = Buffer.alloc(outputWidth * outputHeight * 4);

for (let y = minY; y <= maxY; y += 1) {
  for (let x = minX; x <= maxX; x += 1) {
    const sourceIndex = y * info.width + x;
    const sourceOffset = sourceIndex * info.channels;
    const targetOffset = ((y - minY) * outputWidth + (x - minX)) * 4;
    rgba[targetOffset] = data[sourceOffset];
    rgba[targetOffset + 1] = data[sourceOffset + 1];
    rgba[targetOffset + 2] = data[sourceOffset + 2];

    if (!keep[sourceIndex]) {
      rgba[targetOffset + 3] = 0;
      continue;
    }

    let boundary = false;
    for (let dy = -1; dy <= 1 && !boundary; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (
          nextX < 0 ||
          nextX >= info.width ||
          nextY < 0 ||
          nextY >= info.height ||
          !keep[nextY * info.width + nextX]
        ) {
          boundary = true;
          break;
        }
      }
    }

    if (!boundary) {
      rgba[targetOffset + 3] = 255;
      continue;
    }

    const colorDifference = Math.max(
      Math.abs(data[sourceOffset] - background[0]),
      Math.abs(data[sourceOffset + 1] - background[1]),
      Math.abs(data[sourceOffset + 2] - background[2]),
    );
    rgba[targetOffset + 3] = Math.max(
      48,
      Math.min(255, Math.round(((colorDifference - 3) / 22) * 255)),
    );
  }
}

await sharp(rgba, {
  raw: { width: outputWidth, height: outputHeight, channels: 4 },
})
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(outputPath);

console.log(
  `Extracted ${largestComponent.length} robot pixels to ${outputPath} (${outputWidth}x${outputHeight})`,
);
