import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://safebot.example/", {
      headers: {
        accept: "text/html",
        host: "safebot.example",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the SAFEBOT mobile patrol product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ko">/i);
  assert.match(html, /<title>SAFEBOT \| 주민안전 AI 순찰<\/title>/i);
  assert.match(html, /SAFEBOT/);
  assert.match(html, /카메라 순찰 시작/);
  assert.match(html, /10초 알림 흐름 테스트/);
  assert.match(html, /얼굴 익명화/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("ships the PWA shell and pinned local AI assets", async () => {
  const requiredFiles = [
    "public/manifest.webmanifest",
    "public/sw.js",
    "public/icons/icon-192.png",
    "public/icons/icon-512.png",
    "public/og.png",
    "public/models/pose_landmarker_lite.task",
    "public/models/blaze_face_full_range.tflite",
    "public/models/efficientdet_lite0_uint8.tflite",
    "MODEL_CHECKSUMS.txt",
  ];

  await Promise.all(
    requiredFiles.map((path) => access(new URL(path, templateRoot))),
  );

  const [manifest, serviceWorker, page, visionWorker, packageJson, poseModel] =
    await Promise.all([
      readFile(new URL("public/manifest.webmanifest", templateRoot), "utf8"),
      readFile(new URL("public/sw.js", templateRoot), "utf8"),
      readFile(new URL("app/page.tsx", templateRoot), "utf8"),
      readFile(new URL("app/vision.worker.ts", templateRoot), "utf8"),
      readFile(new URL("package.json", templateRoot), "utf8"),
      stat(new URL("public/models/pose_landmarker_lite.task", templateRoot)),
    ]);

  assert.match(manifest, /"display": "standalone"/);
  assert.match(serviceWorker, /notificationclick/);
  assert.match(serviceWorker, /showNotification/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(page, /FaceDetector|blaze_face_full_range|얼굴/);
  assert.match(
    visionWorker,
    /FilesetResolver\.forVisionTasks\([\s\S]*?true,[\s\S]*?\)/,
  );
  assert.match(visionWorker, /canvas: createTaskCanvas\(\)/);
  assert.match(visionWorker, /new OffscreenCanvas\(1, 1\)/);
  assert.match(packageJson, /"@mediapipe\/tasks-vision": "0\.10\.35"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.ok(poseModel.size > 1_000_000);
  await assert.rejects(
    access(new URL("app/_sites-preview", templateRoot)),
  );
});
