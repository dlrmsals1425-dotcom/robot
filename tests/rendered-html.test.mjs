import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://safebot.example${pathname}`, {
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
  assert.match(
    html,
    /<title>SAFEBOT \| 주민안전 AI 순찰(?:·관제)?<\/title>/i,
  );
  assert.match(html, /SAFEBOT/);
  assert.match(html, /카메라 순찰 시작/);
  assert.match(html, /10초 알림 흐름 테스트/);
  assert.match(html, /얼굴 익명화/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("server-renders the protected SAFEBOT control-center entry", async () => {
  const response = await render("/control");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /SAFEBOT 관제센터 \| 주민안전 AI 순찰/);
  assert.match(html, /보안 연결을 확인하고 있습니다/);
  assert.match(html, /관제 영상과 이벤트 이력은 인증된 담당자에게만 표시/);
  assert.match(html, /현장기기/);
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
  assert.match(serviceWorker, /safebot-shell-v5/);
  assert.match(serviceWorker, /requestUrl\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /requestUrl\.pathname === "\/control"/);
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

test("keeps safety alerts compact and person overlays red", async () => {
  const [page, styles, fallDetection] = await Promise.all([
    readFile(new URL("app/page.tsx", templateRoot), "utf8"),
    readFile(new URL("app/globals.css", templateRoot), "utf8"),
    readFile(new URL("app/fall-detection.ts", templateRoot), "utf8"),
  ]);

  const fallPanelRule = styles.match(/\.fall-panel\s*\{([^}]*)\}/)?.[1] ?? "";
  const emergencyPanelRule =
    styles.match(/\.emergency-panel\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.doesNotMatch(fallPanelRule, /inset:\s*0/);
  assert.match(fallPanelRule, /width:\s*min\(440px/);
  assert.doesNotMatch(emergencyPanelRule, /inset:\s*0/);
  assert.match(emergencyPanelRule, /width:\s*min\(410px/);
  assert.match(page, /const PERSON_DETECTION_COLOR = "#ff4d5a"/);
  assert.match(page, /const OBJECT_DETECTION_COLOR = "#7bd4ff"/);
  assert.match(page, /fusePersonDetections/);
  assert.match(page, /사람 · 자세 추적/);
  assert.doesNotMatch(page, /drawBox\(box,\s*"사람",\s*1/);
  assert.match(page, /for \(const pose of result\.poses\)/);
  assert.match(
    await readFile(new URL("app/vision.worker.ts", templateRoot), "utf8"),
    /deduplicatePoseDetections/,
  );
  assert.match(page, /role="alertdialog"/);
  assert.match(fallDetection, /angleFromHorizontal < 30/);
  assert.match(fallDetection, /completeLeg/);
  assert.match(fallDetection, /FALL_NEGATIVE_BUDGET_MS/);
});

test("ships anonymized clip recording, bounded local storage, and private event APIs", async () => {
  const [page, recorder, clipStore, worker, wrangler, packageJson] =
    await Promise.all([
      readFile(new URL("app/page.tsx", templateRoot), "utf8"),
      readFile(new URL("app/event-recorder.ts", templateRoot), "utf8"),
      readFile(new URL("app/clip-store.ts", templateRoot), "utf8"),
      readFile(new URL("worker/index.ts", templateRoot), "utf8"),
      readFile(new URL("wrangler.jsonc", templateRoot), "utf8"),
      readFile(new URL("package.json", templateRoot), "utf8"),
    ]);

  assert.match(page, /recordingCanvasRef/);
  assert.match(page, /startEventRecording/);
  assert.match(page, /original camera MediaStream is never recorded/);
  assert.doesNotMatch(page, /drawFullyPixelatedFrame/);
  assert.match(page, /fallbackPersonBoxes/);
  assert.match(page, /claimedFaceRegions/);
  assert.match(page, /calculatePoseHeadFallbackBox/);
  assert.match(page, /expandedPersonPrivacyBox/);
  assert.match(page, /PRIVACY_EMPTY_SCANS_REQUIRED = 2/);
  assert.match(page, /PRIVACY_HOLD_MAX_MS/);
  assert.match(page, /보호 확인 중/);
  assert.match(page, /eventUploadPromisesRef/);
  assert.doesNotMatch(page, /globalAlpha\s*=\s*0\.72/);
  assert.match(recorder, /EVENT_RECORDING_MAX_DURATION_MS = 10_000/);
  assert.match(recorder, /video\/mp4;codecs=avc1/);
  assert.match(clipStore, /MAX_LOCAL_EVENT_CLIPS = 5/);
  assert.match(clipStore, /MAX_LOCAL_EVENT_CLIP_BYTES = 50 \* 1024 \* 1024/);
  assert.match(worker, /CONTROL_PASSWORD/);
  assert.match(worker, /SESSION_SECRET/);
  assert.doesNotMatch(worker, /EVENT_MEDIA|R2Bucket/);
  assert.match(worker, /event_media_chunks/);
  assert.match(worker, /MEDIA_CHUNK_BYTES = 1_000_000/);
  assert.match(worker, /MAX_ACTIVE_MEDIA_BYTES = 100_000_000/);
  assert.match(worker, /pathname === "\/api\/events"/);
  assert.match(worker, /eventMatchesUpload/);
  assert.match(worker, /idempotent: true/);
  assert.match(worker, /MAX_CLEANUP_BATCHES/);
  assert.match(wrangler, /"crons": \["17 \* \* \* \*"\]/);
  assert.match(wrangler, /"migrations_dir": "migrations"/);
  assert.match(packageJson, /"migrate:cloudflare"/);
});

test("ships authenticated low-bandwidth TURN live control with a relay fallback", async () => {
  const [page, sender, viewer, ice, worker, control, wrangler] =
    await Promise.all([
      readFile(new URL("app/page.tsx", templateRoot), "utf8"),
      readFile(new URL("app/live-stream.ts", templateRoot), "utf8"),
      readFile(
        new URL("app/control/use-live-viewer.ts", templateRoot),
        "utf8",
      ),
      readFile(new URL("app/live-ice.ts", templateRoot), "utf8"),
      readFile(new URL("worker/index.ts", templateRoot), "utf8"),
      readFile(
        new URL("app/control/control-center.tsx", templateRoot),
        "utf8",
      ),
      readFile(new URL("wrangler.jsonc", templateRoot), "utf8"),
    ]);

  assert.match(page, /new LiveBroadcastSender\(\{\s*canvas,/);
  assert.match(page, /const canvas = recordingCanvasRef\.current/);
  assert.match(page, /관제 실시간 공유/);
  assert.match(page, /pendingLiveBroadcastAfterLoginRef/);
  assert.match(
    page,
    /pendingLiveBroadcastAfterLoginRef\.current\s*=\s*true;[\s\S]*?setShowControlLogin\(true\)/,
  );
  assert.match(
    page,
    /cameraState\s*!==\s*"running"[\s\S]*?controlConnection\s*!==\s*"connected"[\s\S]*?startLiveBroadcast\(\)/,
  );
  assert.match(page, /const cancelControlLogin = useCallback/);
  assert.match(
    page,
    /const stopCamera = useCallback\([\s\S]*?pendingLiveBroadcastAfterLoginRef\.current\s*=\s*false/,
  );
  assert.match(
    page,
    /pendingLiveBroadcastAfterLoginRef\.current[\s\S]*?실시간 공유를 자동으로 시작합니다[\s\S]*?실시간 공유를 직접 시작할 수 있습니다/,
  );
  assert.match(page, /로그인 직후 공유가 자동으로 시작됩니다/);
  assert.doesNotMatch(
    page,
    /cameraState === "running"\s*&&\s*controlConnection === "connected"\s*&&/,
  );
  assert.match(sender, /streamCanvas\.captureStream\(FRAME_RATE\)/);
  assert.match(sender, /getAudioTracks\(\).*track\.stop\(\)/);
  assert.doesNotMatch(sender, /streamRef|navigator\.mediaDevices|getUserMedia/);
  assert.match(sender, /fetchLiveIceServers\(\)/);
  assert.match(sender, /MAX_VIDEO_BITRATE = 350_000/);
  assert.match(sender, /MAX_VIDEO_SHORT_EDGE = 360/);
  assert.match(sender, /MAX_VIDEO_LONG_EDGE = 480/);
  assert.match(sender, /prepareStreamCanvas/);
  assert.match(sender, /await this\.limitSenderBitrate\(sender\)/);
  assert.match(sender, /encoding\.maxFramerate = FRAME_RATE/);
  assert.doesNotMatch(sender, /encoding\.scaleResolutionDownBy/);
  assert.match(sender, /schedulePeerRetry/);
  assert.match(sender, /iceTransportPolicy: "all"/);
  assert.match(sender, /MAX_RECONNECT_ATTEMPTS = 6/);
  assert.match(sender, /RELAY_FRAME_WIDTH = 320/);
  assert.match(sender, /MAX_RELAY_FRAME_BYTES = 48 \* 1024/);
  assert.match(sender, /this\.canvas\.ownerDocument\.createElement\("canvas"\)/);
  assert.match(sender, /canvas\.toBlob\(resolve, "image\/jpeg", quality\)/);
  assert.match(sender, /socket\.send\(await frame\.arrayBuffer\(\)\)/);
  assert.match(sender, /type === "relay-request"/);

  assert.match(viewer, /fetchLiveIceServers\(\)/);
  assert.match(viewer, /iceTransportPolicy: "all"/);
  assert.match(viewer, /MAX_RECONNECT_ATTEMPTS = 8/);
  assert.match(viewer, /send\(\{ type: "relay-request" \}\)/);
  assert.match(viewer, /send\(\{ type: "relay-ack" \}\)/);
  assert.match(viewer, /nextSocket\.binaryType = "arraybuffer"/);
  assert.match(viewer, /new Blob\(\[buffer\], \{ type: "image\/jpeg" \}\)/);
  assert.match(control, /현장 실시간 관제/);
  assert.match(control, /절약형 LIVE · 360p/);
  assert.match(control, /저속 RELAY · 1fps/);
  assert.match(control, /중계 프레임은 서버에 저장하지 않습니다/);

  assert.match(ice, /\/api\/live\/ice-servers/);
  assert.match(ice, /credentials: "same-origin"/);
  assert.match(ice, /cache: "no-store"/);
  assert.match(ice, /stun:stun\.cloudflare\.com:3478/);
  assert.match(ice, /turns\?:turn\\\.cloudflare/);
  assert.match(ice, /DEFAULT_LIVE_ICE_SERVERS/);

  assert.match(worker, /assertLiveSocketOrigin\(request\)/);
  assert.match(worker, /handleLiveIceServers/);
  assert.match(worker, /TURN_KEY_API_TOKEN/);
  assert.match(worker, /generate-ice-servers/);
  assert.match(worker, /TURN_CREDENTIAL_TTL_SECONDS = 60 \* 60/);
  assert.match(worker, /TURN_PROVIDER_MAX_ATTEMPTS_PER_WINDOW = 3/);
  assert.match(worker, /TURN_CACHE_STORAGE_KEY/);
  assert.match(worker, /turnCredentialBrokerName/);
  assert.match(worker, /MAX_TURN_RESPONSE_BYTES = 16 \* 1024/);
  assert.match(worker, /await requireSession\(request, env\)/);
  assert.match(worker, /MAX_LIVE_VIEWERS = 3/);
  assert.match(worker, /MAX_RELAY_FRAME_BYTES = 48 \* 1024/);
  assert.match(worker, /MAX_RELAY_FRAME_WIDTH = 320/);
  assert.match(worker, /readRelayJpegDimensions/);
  assert.match(worker, /MIN_RELAY_FRAME_INTERVAL_MS = 900/);
  assert.match(worker, /viewer\.state\.relayRequested/);
  assert.match(worker, /viewer\.state\.relayAwaitingAck/);
  assert.match(worker, /sendLiveBinary\(viewer\.socket, message\)/);
  assert.match(worker, /acceptWebSocket\(server\)/);
  assert.doesNotMatch(worker, /R2Bucket|EVENT_MEDIA/);
  assert.match(wrangler, /"name": "LIVE_ROOM"/);
  assert.match(wrangler, /"new_sqlite_classes": \["LiveRoom"\]/);
  assert.doesNotMatch(wrangler, /r2_buckets/i);
  assert.doesNotMatch(wrangler, /TURN_KEY_API_TOKEN|turn\.cloudflare\.com/i);
});
