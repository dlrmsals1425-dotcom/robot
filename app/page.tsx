"use client";

import {
  Activity,
  Bell,
  BellRing,
  Bot,
  Camera,
  CameraOff,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  EyeOff,
  FileClock,
  History,
  Info,
  MapPin,
  OctagonAlert,
  Pause,
  Play,
  Radio,
  RotateCcw,
  ScanLine,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TriangleAlert,
  UserRound,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AppView = "patrol" | "history" | "guide";
type CameraState = "idle" | "starting" | "running" | "error";
type ModelState = "idle" | "loading" | "ready" | "error";
type AlertPhase = "idle" | "verifying" | "alerted" | "recovered";
type EventStatus =
  | "emergency"
  | "recovered"
  | "false_positive"
  | "interrupted";

type PosePoint = {
  x: number;
  y: number;
  z: number;
  visibility: number;
};

type DetectionBox = {
  originX: number;
  originY: number;
  width: number;
  height: number;
};

type PlainDetection = {
  boundingBox?: DetectionBox;
  categoryName: string;
  displayName: string;
  score: number;
};

type VisionResult = {
  type: "result";
  timestamp: number;
  frameWidth: number;
  frameHeight: number;
  poses: PosePoint[][];
  faces: PlainDetection[];
  objects: PlainDetection[];
  objectUpdated: boolean;
  latencyMs: number;
};

type SafetyEvent = {
  id: string;
  status: EventStatus;
  title: string;
  detail: string;
  createdAt: string;
  durationSeconds: number;
  confidence: number;
  notification: "sent" | "not_sent" | "permission_needed";
  snapshot?: string;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type VisionStats = {
  people: number;
  objects: number;
  confidence: number;
  latencyMs: number;
};

const FALL_CONFIRMATION_MS = 10_000;
const SUSPECT_STABILITY_MS = 900;
const RECOVERY_STABILITY_MS = 850;
const LOST_TRACKING_MS = 1_100;
const STORAGE_KEY = "safebot-safety-events-v1";

const POSE_CONNECTIONS = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
];

const KOREAN_LABELS: Record<string, string> = {
  person: "사람",
  bicycle: "자전거",
  car: "차량",
  motorcycle: "오토바이",
  bus: "버스",
  truck: "트럭",
  dog: "반려견",
  cat: "고양이",
  bench: "벤치",
  backpack: "가방",
  umbrella: "우산",
  bottle: "병",
  chair: "의자",
};

function formatTime(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(iso));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getPoseBounds(pose: PosePoint[]) {
  const visible = pose.filter(
    (point) =>
      point.visibility > 0.45 &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y),
  );

  if (visible.length < 8) return null;

  const xs = visible.map((point) => point.x);
  const ys = visible.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function analyzeFallPose(pose: PosePoint[]) {
  const required = [11, 12, 23, 24].map((index) => pose[index]);
  if (
    required.some(
      (point) =>
        !point ||
        point.visibility < 0.52 ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y),
    )
  ) {
    return { isLying: false, confidence: 0 };
  }

  const [leftShoulder, rightShoulder, leftHip, rightHip] = required;
  const shoulder = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const hip = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };
  const dx = Math.abs(hip.x - shoulder.x);
  const dy = Math.abs(hip.y - shoulder.y);
  const angleFromHorizontal =
    (Math.atan2(dy, Math.max(dx, 0.0001)) * 180) / Math.PI;
  const bounds = getPoseBounds(pose);

  if (!bounds) return { isLying: false, confidence: 0 };

  const width = Math.max(bounds.maxX - bounds.minX, 0.001);
  const height = Math.max(bounds.maxY - bounds.minY, 0.001);
  const aspectRatio = width / height;
  const horizontalScore = clamp((55 - angleFromHorizontal) / 35, 0, 1);
  const aspectScore = clamp((aspectRatio - 0.78) / 0.62, 0, 1);
  const lowerFrameScore = clamp((hip.y - 0.32) / 0.42, 0, 1);
  const confidence =
    horizontalScore * 0.5 + aspectScore * 0.35 + lowerFrameScore * 0.15;

  return {
    isLying:
      angleFromHorizontal < 42 &&
      aspectRatio > 0.95 &&
      confidence >= 0.58,
    confidence,
  };
}

function eventStatusLabel(status: EventStatus) {
  switch (status) {
    case "emergency":
      return "알림 발송";
    case "recovered":
      return "회복";
    case "false_positive":
      return "오탐";
    case "interrupted":
      return "확인 중단";
  }
}

function eventIcon(status: EventStatus) {
  switch (status) {
    case "emergency":
      return <BellRing size={18} aria-hidden="true" />;
    case "recovered":
      return <CheckCircle2 size={18} aria-hidden="true" />;
    case "false_positive":
      return <RotateCcw size={18} aria-hidden="true" />;
    case "interrupted":
      return <Pause size={18} aria-hidden="true" />;
  }
}

export default function Home() {
  const [view, setView] = useState<AppView>("patrol");
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [modelState, setModelState] = useState<ModelState>("idle");
  const [modelMessage, setModelMessage] = useState(
    "카메라를 켜면 AI 모델을 준비합니다.",
  );
  const [alertPhase, setAlertPhase] = useState<AlertPhase>("idle");
  const [countdown, setCountdown] = useState(10);
  const [fallConfidence, setFallConfidence] = useState(0);
  const [visionStats, setVisionStats] = useState<VisionStats>({
    people: 0,
    objects: 0,
    confidence: 0,
    latencyMs: 0,
  });
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");
  const [toast, setToast] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [manualScenario, setManualScenario] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement>(null);
  const pixelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef<Promise<void> | null>(null);
  const workerBusyRef = useRef(false);
  const latestResultRef = useRef<VisionResult | null>(null);
  const animationRef = useRef<number | null>(null);
  const inferenceRef = useRef<number | null>(null);
  const alertPhaseRef = useRef<AlertPhase>("idle");
  const verificationStartedRef = useRef<number | null>(null);
  const suspectStartedRef = useRef<number | null>(null);
  const uprightStartedRef = useRef<number | null>(null);
  const lastPositiveRef = useRef<number | null>(null);
  const emergencyTriggeredRef = useRef(false);
  const manualScenarioRef = useRef(false);
  const eventsRef = useRef<SafetyEvent[]>([]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVisionResultRef = useRef<(result: VisionResult) => void>(() => {});

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const setPhase = useCallback((phase: AlertPhase) => {
    alertPhaseRef.current = phase;
    setAlertPhase(phase);
  }, []);

  const captureSnapshot = useCallback(() => {
    const source = canvasRef.current;
    if (!source || source.width === 0 || source.height === 0) return undefined;

    try {
      const snapshot = document.createElement("canvas");
      const maxWidth = 420;
      const scale = Math.min(1, maxWidth / source.width);
      snapshot.width = Math.max(1, Math.round(source.width * scale));
      snapshot.height = Math.max(1, Math.round(source.height * scale));
      const context = snapshot.getContext("2d");
      if (!context) return undefined;
      context.drawImage(source, 0, 0, snapshot.width, snapshot.height);
      return snapshot.toDataURL("image/jpeg", 0.62);
    } catch {
      return undefined;
    }
  }, []);

  const persistEvents = useCallback((nextEvents: SafetyEvent[]) => {
    eventsRef.current = nextEvents;
    setEvents(nextEvents);
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(nextEvents.slice(0, 16)),
      );
    } catch {
      // Storage can be unavailable in private browsing. The in-memory history
      // remains usable for the current session.
    }
  }, []);

  const addEvent = useCallback(
    (
      status: EventStatus,
      title: string,
      detail: string,
      durationSeconds: number,
      confidence: number,
      notification: SafetyEvent["notification"],
    ) => {
      const snapshot = captureSnapshot();
      const event: SafetyEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        status,
        title,
        detail,
        createdAt: new Date().toISOString(),
        durationSeconds,
        confidence,
        notification,
        snapshot,
      };
      persistEvents([event, ...eventsRef.current].slice(0, 16));
      return event;
    },
    [captureSnapshot, persistEvents],
  );

  const sendDeviceNotification = useCallback(async () => {
    if (
      !("Notification" in window) ||
      Notification.permission !== "granted"
    ) {
      return false;
    }

    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification("SAFEBOT · 쓰러짐 의심 알림", {
          body: "10초간 누운 자세가 지속되었습니다. 현장 확인이 필요합니다.",
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          tag: "safebot-fall-alert",
          data: { url: "/?event=latest" },
        });
      } else {
        new Notification("SAFEBOT · 쓰러짐 의심 알림", {
          body: "10초간 누운 자세가 지속되었습니다. 현장 확인이 필요합니다.",
          icon: "/icons/icon-192.png",
          tag: "safebot-fall-alert",
        });
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const resetDetectionState = useCallback(() => {
    verificationStartedRef.current = null;
    suspectStartedRef.current = null;
    uprightStartedRef.current = null;
    lastPositiveRef.current = null;
    emergencyTriggeredRef.current = false;
    manualScenarioRef.current = false;
    setManualScenario(false);
    setCountdown(10);
    setFallConfidence(0);
  }, []);

  const finishEmergency = useCallback(async () => {
    if (emergencyTriggeredRef.current) return;
    emergencyTriggeredRef.current = true;
    const duration = verificationStartedRef.current
      ? Math.max(
          10,
          Math.round(
            (performance.now() - verificationStartedRef.current) / 1000,
          ),
        )
      : 10;
    const notificationSent = await sendDeviceNotification();
    const permission =
      "Notification" in window ? Notification.permission : "denied";

    setPhase("alerted");
    setCountdown(0);
    addEvent(
      "emergency",
      "쓰러짐 의심 · 관제 확인 필요",
      "누운 자세가 10초간 연속 감지되어 기기 알림을 생성했습니다.",
      duration,
      fallConfidence || 0.82,
      notificationSent
        ? "sent"
        : permission === "granted"
          ? "not_sent"
          : "permission_needed",
    );
    showToast(
      notificationSent
        ? "기기 알림을 발송했습니다."
        : "이벤트를 기록했습니다. 알림 권한을 확인해 주세요.",
    );
  }, [
    addEvent,
    fallConfidence,
    sendDeviceNotification,
    setPhase,
    showToast,
  ]);

  const beginVerification = useCallback(
    (confidence: number, isManual = false) => {
      if (alertPhaseRef.current !== "idle") return;
      const now = performance.now();
      verificationStartedRef.current = now;
      lastPositiveRef.current = now;
      emergencyTriggeredRef.current = false;
      manualScenarioRef.current = isManual;
      setManualScenario(isManual);
      setFallConfidence(confidence);
      setCountdown(10);
      setPhase("verifying");
      showToast(
        isManual
          ? "10초 알림 흐름 테스트를 시작했습니다."
          : "누운 자세를 확인하고 있습니다.",
      );
    },
    [setPhase, showToast],
  );

  const resolveVerification = useCallback(
    (status: "recovered" | "false_positive" | "interrupted") => {
      if (alertPhaseRef.current !== "verifying") return;
      const duration = verificationStartedRef.current
        ? Math.max(
            1,
            Math.round(
              (performance.now() - verificationStartedRef.current) / 1000,
            ),
          )
        : 1;

      const content = {
        recovered: {
          title: "상태 회복",
          detail:
            "10초 이내에 다시 선 자세가 확인되어 알림 없이 회복 이력만 남겼습니다.",
        },
        false_positive: {
          title: "오탐으로 취소",
          detail: "현장 테스트에서 오탐으로 확인되어 알림을 취소했습니다.",
        },
        interrupted: {
          title: "확인 중단",
          detail:
            "사람 추적 또는 카메라 연결이 끊겨 판단을 중단했습니다. 관제 확인이 필요할 수 있습니다.",
        },
      }[status];

      addEvent(
        status,
        content.title,
        content.detail,
        duration,
        fallConfidence,
        "not_sent",
      );
      setPhase(status === "recovered" ? "recovered" : "idle");
      showToast(
        status === "recovered"
          ? "회복 이력만 저장했습니다."
          : status === "false_positive"
            ? "오탐으로 기록했습니다."
            : "확인 중단 이력을 저장했습니다.",
      );
      resetDetectionState();
      if (status === "recovered") {
        setTimeout(() => {
          if (alertPhaseRef.current === "recovered") setPhase("idle");
        }, 2400);
      }
    },
    [
      addEvent,
      fallConfidence,
      resetDetectionState,
      setPhase,
      showToast,
    ],
  );

  const acknowledgeEmergency = useCallback(() => {
    setPhase("idle");
    resetDetectionState();
    showToast("관제 확인 완료로 표시했습니다.");
  }, [resetDetectionState, setPhase, showToast]);

  const handleVisionResult = useCallback(
    (result: VisionResult) => {
      latestResultRef.current = result;
      workerBusyRef.current = false;

      const objectPeople = result.objects.filter(
        (detection) => detection.categoryName === "person",
      ).length;
      const people = Math.max(result.poses.length, objectPeople);
      const nonPeople = result.objects.filter(
        (detection) => detection.categoryName !== "person",
      ).length;
      const analyses = result.poses.map(analyzeFallPose);
      const strongest = analyses.reduce(
        (best, current) =>
          current.confidence > best.confidence ? current : best,
        { isLying: false, confidence: 0 },
      );

      setVisionStats({
        people,
        objects: nonPeople,
        confidence: strongest.confidence,
        latencyMs: result.latencyMs,
      });

      if (manualScenarioRef.current) return;

      const now = performance.now();
      if (strongest.isLying) {
        lastPositiveRef.current = now;
        uprightStartedRef.current = null;
        setFallConfidence(strongest.confidence);

        if (suspectStartedRef.current === null) {
          suspectStartedRef.current = now;
        }

        if (
          alertPhaseRef.current === "idle" &&
          now - suspectStartedRef.current >= SUSPECT_STABILITY_MS
        ) {
          beginVerification(strongest.confidence);
        }
        return;
      }

      suspectStartedRef.current = null;
      if (alertPhaseRef.current !== "verifying") return;

      if (result.poses.length === 0) {
        if (
          lastPositiveRef.current &&
          now - lastPositiveRef.current > LOST_TRACKING_MS
        ) {
          resolveVerification("interrupted");
        }
        return;
      }

      if (uprightStartedRef.current === null) {
        uprightStartedRef.current = now;
      }
      if (
        now - uprightStartedRef.current >= RECOVERY_STABILITY_MS
      ) {
        resolveVerification("recovered");
      }
    },
    [beginVerification, resolveVerification],
  );

  useEffect(() => {
    handleVisionResultRef.current = handleVisionResult;
  }, [handleVisionResult]);

  const ensureVisionWorker = useCallback(() => {
    if (workerReadyRef.current) return workerReadyRef.current;

    setModelState("loading");
    setModelMessage("사람 자세·얼굴·사물 모델을 불러오는 중입니다.");

    workerReadyRef.current = new Promise<void>((resolve, reject) => {
      try {
        const worker = new Worker(new URL("./vision.worker.ts", import.meta.url), {
          type: "module",
        });
        workerRef.current = worker;

        const timeout = window.setTimeout(() => {
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          setModelState("error");
          const timeoutMessage =
            "AI 모델 준비 시간이 초과되었습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
          setModelMessage(timeoutMessage);
          reject(new Error(timeoutMessage));
        }, 90_000);

        worker.onmessage = (
          event: MessageEvent<
            | { type: "ready" }
            | { type: "error"; message: string }
            | VisionResult
          >,
        ) => {
          if (event.data.type === "ready") {
            window.clearTimeout(timeout);
            setModelState("ready");
            setModelMessage("AI 익명화와 자세 분석이 기기에서 실행 중입니다.");
            resolve();
            return;
          }
          if (event.data.type === "error") {
            window.clearTimeout(timeout);
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
            workerBusyRef.current = false;
            setModelState("error");
            setModelMessage(event.data.message);
            reject(new Error(event.data.message));
            return;
          }
          handleVisionResultRef.current(event.data);
        };

        worker.onerror = (event) => {
          window.clearTimeout(timeout);
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          workerBusyRef.current = false;
          setModelState("error");
          const detail = event.message
            ? `AI 실행 환경 오류: ${event.message}`
            : "이 기기에서 AI 모델을 시작하지 못했습니다.";
          setModelMessage(detail);
          reject(new Error(detail));
        };

        worker.postMessage({
          type: "init",
          baseUrl: window.location.origin,
        });
      } catch (error) {
        setModelState("error");
        setModelMessage("이 브라우저는 기기 내 AI 분석을 지원하지 않습니다.");
        reject(error);
      }
    }).catch((error) => {
      workerReadyRef.current = null;
      throw error;
    });

    return workerReadyRef.current;
  }, []);

  const drawPixelatedRegion = useCallback(
    (
      context: CanvasRenderingContext2D,
      video: HTMLVideoElement,
      box: DetectionBox,
      analysisWidth: number,
      analysisHeight: number,
      expansion = 0.3,
    ) => {
      const canvas = context.canvas;
      const scaleX = canvas.width / analysisWidth;
      const scaleY = canvas.height / analysisHeight;
      const expandedWidth = box.width * (1 + expansion * 2);
      const expandedHeight = box.height * (1 + expansion * 2);
      const x = clamp(
        (box.originX - box.width * expansion) * scaleX,
        0,
        canvas.width,
      );
      const y = clamp(
        (box.originY - box.height * expansion) * scaleY,
        0,
        canvas.height,
      );
      const width = clamp(expandedWidth * scaleX, 1, canvas.width - x);
      const height = clamp(expandedHeight * scaleY, 1, canvas.height - y);

      if (!pixelCanvasRef.current) {
        pixelCanvasRef.current = document.createElement("canvas");
      }
      const pixelCanvas = pixelCanvasRef.current;
      pixelCanvas.width = Math.max(6, Math.round(width / 15));
      pixelCanvas.height = Math.max(6, Math.round(height / 15));
      const pixelContext = pixelCanvas.getContext("2d");
      if (!pixelContext) return;

      pixelContext.imageSmoothingEnabled = true;
      pixelContext.clearRect(0, 0, pixelCanvas.width, pixelCanvas.height);
      pixelContext.drawImage(
        video,
        x,
        y,
        width,
        height,
        0,
        0,
        pixelCanvas.width,
        pixelCanvas.height,
      );

      context.save();
      context.beginPath();
      context.ellipse(
        x + width / 2,
        y + height / 2,
        width / 2,
        height / 2,
        0,
        0,
        Math.PI * 2,
      );
      context.clip();
      context.imageSmoothingEnabled = false;
      context.drawImage(pixelCanvas, x, y, width, height);
      context.restore();
      context.imageSmoothingEnabled = true;
    },
    [],
  );

  const drawCanvasFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (
      !video ||
      !canvas ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth === 0
    ) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) return;

    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const result = latestResultRef.current;
    const resultIsFresh =
      result && performance.now() - result.timestamp < 1_500;

    if (result && resultIsFresh) {
      const faceBoxes = result.faces
        .map((face) => face.boundingBox)
        .filter((box): box is DetectionBox => Boolean(box));

      for (const faceBox of faceBoxes) {
        drawPixelatedRegion(
          context,
          video,
          faceBox,
          result.frameWidth,
          result.frameHeight,
          0.34,
        );
      }

      for (const pose of result.poses) {
        const facePoints = pose.slice(0, 11).filter((point) => point.visibility > 0.45);
        if (facePoints.length >= 3) {
          const xs = facePoints.map((point) => point.x * result.frameWidth);
          const ys = facePoints.map((point) => point.y * result.frameHeight);
          const poseFaceBox = {
            originX: Math.min(...xs),
            originY: Math.min(...ys),
            width: Math.max(18, Math.max(...xs) - Math.min(...xs)),
            height: Math.max(22, Math.max(...ys) - Math.min(...ys)),
          };
          drawPixelatedRegion(
            context,
            video,
            poseFaceBox,
            result.frameWidth,
            result.frameHeight,
            0.55,
          );
        }
      }

      const peopleWithoutFaceFallback = result.objects.filter(
        (detection) =>
          detection.categoryName === "person" && detection.boundingBox,
      );
      for (const person of peopleWithoutFaceFallback) {
        const box = person.boundingBox!;
        const headBox = {
          originX: box.originX + box.width * 0.24,
          originY: box.originY,
          width: box.width * 0.52,
          height: box.height * 0.28,
        };
        drawPixelatedRegion(
          context,
          video,
          headBox,
          result.frameWidth,
          result.frameHeight,
          0.2,
        );
      }

      const scaleX = canvas.width / result.frameWidth;
      const scaleY = canvas.height / result.frameHeight;
      context.lineWidth = Math.max(2, canvas.width / 420);
      context.font = `600 ${Math.max(13, canvas.width / 45)}px system-ui`;
      context.textBaseline = "top";

      for (const detection of result.objects.slice(0, 10)) {
        if (!detection.boundingBox) continue;
        const { originX, originY, width, height } = detection.boundingBox;
        const isPerson = detection.categoryName === "person";
        const color = isPerson ? "#8cf2b2" : "#7bd4ff";
        const x = originX * scaleX;
        const y = originY * scaleY;
        const boxWidth = width * scaleX;
        const boxHeight = height * scaleY;
        context.strokeStyle = color;
        context.fillStyle = color;
        context.strokeRect(x, y, boxWidth, boxHeight);
        const label =
          KOREAN_LABELS[detection.categoryName] ||
          detection.displayName ||
          detection.categoryName;
        const text = `${label} ${Math.round(detection.score * 100)}%`;
        const textWidth = context.measureText(text).width + 14;
        context.fillRect(x, Math.max(0, y - 27), textWidth, 27);
        context.fillStyle = "#07150f";
        context.fillText(text, x + 7, Math.max(2, y - 24));
      }

      const pose = result.poses[0];
      if (pose) {
        const fall = analyzeFallPose(pose);
        const poseColor =
          alertPhaseRef.current === "alerted"
            ? "#ff6b64"
            : fall.isLying
              ? "#ffb558"
              : "#9cf6bd";
        context.strokeStyle = poseColor;
        context.fillStyle = poseColor;
        context.lineWidth = Math.max(2.5, canvas.width / 360);

        for (const [start, end] of POSE_CONNECTIONS) {
          const a = pose[start];
          const b = pose[end];
          if (!a || !b || a.visibility < 0.45 || b.visibility < 0.45) continue;
          context.beginPath();
          context.moveTo(a.x * canvas.width, a.y * canvas.height);
          context.lineTo(b.x * canvas.width, b.y * canvas.height);
          context.stroke();
        }
      }
    } else {
      const width = 64;
      const height = Math.max(36, Math.round((canvas.height / canvas.width) * 64));
      if (!pixelCanvasRef.current) {
        pixelCanvasRef.current = document.createElement("canvas");
      }
      const privacyCanvas = pixelCanvasRef.current;
      privacyCanvas.width = width;
      privacyCanvas.height = height;
      const privacyContext = privacyCanvas.getContext("2d");
      if (privacyContext) {
        privacyContext.drawImage(video, 0, 0, width, height);
        context.save();
        context.globalAlpha = 0.72;
        context.imageSmoothingEnabled = false;
        context.drawImage(
          privacyCanvas,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        context.restore();
      }
    }
  }, [drawPixelatedRegion]);

  const startRenderAndInferenceLoops = useCallback(() => {
    const render = () => {
      drawCanvasFrame();
      animationRef.current = requestAnimationFrame(render);
    };

    const infer = async () => {
      const video = videoRef.current;
      const analysisCanvas = analysisCanvasRef.current;
      const worker = workerRef.current;
      if (
        !video ||
        !analysisCanvas ||
        !worker ||
        workerBusyRef.current ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        document.visibilityState !== "visible"
      ) {
        inferenceRef.current = window.setTimeout(infer, 110);
        return;
      }

      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      const scale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight));
      analysisCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
      analysisCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const analysisContext = analysisCanvas.getContext("2d", {
        alpha: false,
      });

      if (analysisContext) {
        analysisContext.drawImage(
          video,
          0,
          0,
          analysisCanvas.width,
          analysisCanvas.height,
        );
        try {
          workerBusyRef.current = true;
          const frame = await createImageBitmap(analysisCanvas);
          worker.postMessage(
            {
              type: "frame",
              frame,
              timestamp: performance.now(),
            },
            [frame],
          );
        } catch {
          workerBusyRef.current = false;
        }
      }
      inferenceRef.current = window.setTimeout(infer, 170);
    };

    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    if (inferenceRef.current) window.clearTimeout(inferenceRef.current);
    render();
    void infer();
  }, [drawCanvasFrame]);

  const stopLoops = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (inferenceRef.current) {
      window.clearTimeout(inferenceRef.current);
      inferenceRef.current = null;
    }
    workerBusyRef.current = false;
  }, []);

  const stopCamera = useCallback(
    (reason?: "user" | "background") => {
      stopLoops();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraState("idle");
      setVisionStats({ people: 0, objects: 0, confidence: 0, latencyMs: 0 });
      latestResultRef.current = null;

      if (
        alertPhaseRef.current === "verifying" &&
        reason === "background"
      ) {
        resolveVerification("interrupted");
      }
      if (reason === "user") showToast("카메라 순찰을 종료했습니다.");
    },
    [resolveVerification, showToast, stopLoops],
  );

  const startCamera = useCallback(async () => {
    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setCameraState("error");
      setModelMessage("카메라는 HTTPS 보안 연결에서만 사용할 수 있습니다.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState("error");
      setModelMessage("이 브라우저에서는 카메라를 사용할 수 없습니다.");
      return;
    }

    setCameraState("starting");
    let requestedStream: MediaStream | null = null;
    try {
      const modelPromise = ensureVisionWorker();
      requestedStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      await modelPromise;
      streamRef.current = requestedStream;

      const video = videoRef.current;
      if (!video) throw new Error("Video element unavailable");
      video.srcObject = requestedStream;
      await video.play();
      setCameraState("running");
      startRenderAndInferenceLoops();
      showToast("기기 안에서 AI 순찰을 시작했습니다.");
    } catch (error) {
      requestedStream?.getTracks().forEach((track) => track.stop());
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraState("error");
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setModelMessage(
          "카메라 권한이 꺼져 있습니다. 브라우저 설정에서 허용해 주세요.",
        );
      } else {
        setModelMessage(
          error instanceof Error && error.message.startsWith("AI 모델")
            ? error.message
            : "카메라를 시작하지 못했습니다. 다른 앱이 카메라를 사용 중인지 확인해 주세요.",
        );
      }
    }
  }, [
    ensureVisionWorker,
    showToast,
    startRenderAndInferenceLoops,
  ]);

  const enableNotifications = useCallback(async () => {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      showToast("이 브라우저에서는 기기 알림을 지원하지 않습니다.");
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted") {
      showToast("긴급 기기 알림이 켜졌습니다.");
      try {
        if ("serviceWorker" in navigator) {
          const registration = await navigator.serviceWorker.ready;
          await registration.showNotification("SAFEBOT 알림 준비 완료", {
            body: "10초 확인이 완료되면 이 기기에 안전 알림을 표시합니다.",
            icon: "/icons/icon-192.png",
            badge: "/icons/icon-192.png",
            tag: "safebot-ready",
          });
        }
      } catch {
        // Permission is still retained even if the confirmation notification
        // cannot be displayed by a particular browser.
      }
    } else if (permission === "denied") {
      showToast("브라우저 설정에서 알림을 다시 허용할 수 있습니다.");
    }
  }, [showToast]);

  const installApp = useCallback(async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstallPrompt(null);
        showToast("홈 화면에 SAFEBOT을 추가했습니다.");
      }
      return;
    }
    showToast("iPhone은 공유 버튼에서 ‘홈 화면에 추가’를 선택해 주세요.");
  }, [installPrompt, showToast]);

  const runFallTest = useCallback(() => {
    if (alertPhaseRef.current !== "idle") return;
    beginVerification(0.86, true);
  }, [beginVerification]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (alertPhaseRef.current !== "verifying") return;
      const startedAt = verificationStartedRef.current;
      if (!startedAt) return;
      const now = performance.now();
      if (
        !manualScenarioRef.current &&
        lastPositiveRef.current &&
        now - lastPositiveRef.current > LOST_TRACKING_MS
      ) {
        resolveVerification("interrupted");
        return;
      }
      const elapsed = now - startedAt;
      const remaining = Math.max(
        0,
        Math.ceil((FALL_CONFIRMATION_MS - elapsed) / 1000),
      );
      setCountdown(remaining);
      if (elapsed >= FALL_CONFIRMATION_MS) void finishEmergency();
    }, 120);
    return () => window.clearInterval(interval);
  }, [finishEmergency, resolveVerification]);

  useEffect(() => {
    const initializeClientState = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as SafetyEvent[];
          eventsRef.current = parsed;
          setEvents(parsed);
        }
      } catch {
        eventsRef.current = [];
      } finally {
        setHistoryLoaded(true);
      }

      if ("Notification" in window) {
        setNotificationPermission(Notification.permission);
      } else {
        setNotificationPermission("unsupported");
      }

      const standalone =
        window.matchMedia("(display-mode: standalone)").matches ||
        ("standalone" in navigator &&
          Boolean(
            (navigator as Navigator & { standalone?: boolean }).standalone,
          ));
      setIsStandalone(standalone);
    }, 0);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // The core foreground camera experience remains available.
      });
    }

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => {
      window.clearTimeout(initializeClientState);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    };
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (
        document.visibilityState === "hidden" &&
        streamRef.current
      ) {
        stopCamera("background");
        showToast(
          "화면이 닫혀 감지를 중단했습니다. 다시 열고 카메라를 시작해 주세요.",
        );
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [showToast, stopCamera]);

  useEffect(
    () => () => {
      stopLoops();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      workerRef.current?.terminate();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [stopLoops],
  );

  const todayEvents = useMemo(() => {
    const today = new Date().toDateString();
    return events.filter(
      (event) => new Date(event.createdAt).toDateString() === today,
    );
  }, [events]);

  const emergencyCount = todayEvents.filter(
    (event) => event.status === "emergency",
  ).length;
  const recoveredCount = todayEvents.filter(
    (event) => event.status === "recovered",
  ).length;

  const cameraStatusLabel =
    cameraState === "running"
      ? "AI 순찰 중"
      : cameraState === "starting"
        ? "연결 중"
        : cameraState === "error"
          ? "확인 필요"
          : "대기 중";

  return (
    <main className="app-root">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => setView("patrol")}
          aria-label="SAFEBOT 순찰 화면으로 이동"
        >
          <span className="brand-mark">
            <ShieldCheck size={21} strokeWidth={2.3} aria-hidden="true" />
          </span>
          <span>
            <strong>SAFEBOT</strong>
            <small>주민안전 AI 순찰</small>
          </span>
        </button>
        <div className="topbar-actions">
          <span
            className={`connection-pill ${cameraState === "running" ? "is-live" : ""}`}
          >
            <span className="status-dot" />
            {cameraStatusLabel}
          </span>
          <button
            className={`icon-button ${notificationPermission === "granted" ? "is-active" : ""}`}
            onClick={enableNotifications}
            aria-label="긴급 기기 알림 설정"
            title="긴급 기기 알림 설정"
          >
            {notificationPermission === "granted" ? (
              <BellRing size={20} aria-hidden="true" />
            ) : (
              <Bell size={20} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="side-nav" aria-label="주요 메뉴">
          <div className="side-nav-group">
            <button
              className={view === "patrol" ? "active" : ""}
              onClick={() => setView("patrol")}
            >
              <ScanLine size={19} aria-hidden="true" />
              라이브 순찰
            </button>
            <button
              className={view === "history" ? "active" : ""}
              onClick={() => setView("history")}
            >
              <History size={19} aria-hidden="true" />
              이벤트 이력
              {events.length > 0 && <span className="nav-count">{events.length}</span>}
            </button>
            <button
              className={view === "guide" ? "active" : ""}
              onClick={() => setView("guide")}
            >
              <Settings2 size={19} aria-hidden="true" />
              운영 안내
            </button>
          </div>

          <div className="side-status-card">
            <div className="side-status-icon">
              <EyeOff size={19} aria-hidden="true" />
            </div>
            <div>
              <strong>Privacy by default</strong>
              <p>원본 영상은 업로드하지 않고 얼굴을 기기에서 익명화합니다.</p>
            </div>
          </div>
        </aside>

        <section className="content">
          {view === "patrol" && (
            <>
              <div className="page-heading patrol-heading">
                <div>
                  <span className="eyebrow">
                    <Radio size={14} aria-hidden="true" />
                    MOBILE EDGE VISION
                  </span>
                  <h1>주변을 살피고, 위험 신호를 놓치지 않도록.</h1>
                  <p>
                    휴대폰 후면 카메라로 사람과 사물을 감지하고 누운
                    자세를 10초간 확인합니다.
                  </p>
                </div>
                <div className="heading-actions">
                  {!isStandalone && (
                    <button className="button button-ghost" onClick={installApp}>
                      <Download size={17} aria-hidden="true" />
                      홈 화면에 추가
                    </button>
                  )}
                  {cameraState === "running" ? (
                    <button
                      className="button button-danger-soft"
                      onClick={() => stopCamera("user")}
                    >
                      <CameraOff size={17} aria-hidden="true" />
                      순찰 종료
                    </button>
                  ) : (
                    <button
                      className="button button-primary"
                      onClick={startCamera}
                      disabled={cameraState === "starting"}
                    >
                      {cameraState === "starting" ? (
                        <Activity
                          className="spin"
                          size={17}
                          aria-hidden="true"
                        />
                      ) : (
                        <Camera size={17} aria-hidden="true" />
                      )}
                      {cameraState === "starting"
                        ? "AI 준비 중"
                        : "카메라 순찰 시작"}
                    </button>
                  )}
                </div>
              </div>

              <section
                className={`camera-card phase-${alertPhase}`}
                aria-label="라이브 AI 순찰 카메라"
              >
                <div className="camera-toolbar">
                  <div className="camera-name">
                    <span
                      className={`live-indicator ${cameraState === "running" ? "active" : ""}`}
                    />
                    <strong>모바일 순찰 카메라 01</strong>
                    <span>일반 외부 환경</span>
                  </div>
                  <div className="camera-signals">
                    <span>
                      <Wifi size={14} aria-hidden="true" />
                      기기 내 처리
                    </span>
                    <span>
                      <EyeOff size={14} aria-hidden="true" />
                      얼굴 익명화
                    </span>
                  </div>
                </div>

                <div className="camera-viewport">
                  <video
                    ref={videoRef}
                    className="source-video"
                    playsInline
                    muted
                    aria-hidden="true"
                  />
                  <canvas
                    ref={canvasRef}
                    className="vision-canvas"
                    aria-label="얼굴이 익명화된 실시간 카메라 화면"
                  />
                  <canvas
                    ref={analysisCanvasRef}
                    className="analysis-canvas"
                    aria-hidden="true"
                  />

                  {cameraState !== "running" && (
                    <div className="camera-placeholder">
                      <div className="radar-orbit" aria-hidden="true">
                        <span />
                        <span />
                        <div className="radar-core">
                          {cameraState === "starting" ? (
                            <Activity className="spin" size={28} />
                          ) : (
                            <Bot size={30} />
                          )}
                        </div>
                      </div>
                      <div>
                        <strong>
                          {cameraState === "starting"
                            ? "휴대폰 안에서 AI를 준비하고 있습니다"
                            : cameraState === "error"
                              ? "카메라 연결을 확인해 주세요"
                              : "카메라를 켜면 AI 순찰이 시작됩니다"}
                        </strong>
                        <p>{modelMessage}</p>
                      </div>
                      {cameraState !== "starting" && (
                        <button
                          className="button button-light"
                          onClick={startCamera}
                        >
                          <Camera size={18} aria-hidden="true" />
                          후면 카메라 연결
                        </button>
                      )}
                    </div>
                  )}

                  {cameraState === "running" && (
                    <>
                      <div className="vision-top-overlay">
                        <span className="ai-chip">
                          <Sparkles size={13} aria-hidden="true" />
                          AI LIVE
                        </span>
                        <span className="privacy-chip">
                          <ShieldCheck size={13} aria-hidden="true" />
                          RAW VIDEO OFF
                        </span>
                      </div>
                      <div className="vision-bottom-overlay">
                        <span>
                          <UserRound size={15} aria-hidden="true" />
                          사람 {visionStats.people}
                        </span>
                        <span>
                          <ScanLine size={15} aria-hidden="true" />
                          사물 {visionStats.objects}
                        </span>
                        <span className="latency">
                          {visionStats.latencyMs > 0
                            ? `${Math.round(visionStats.latencyMs)}ms`
                            : "분석 중"}
                        </span>
                      </div>
                    </>
                  )}

                  {alertPhase === "verifying" && (
                    <div className="fall-panel" role="alert" aria-live="assertive">
                      <div className="countdown-ring">
                        <svg viewBox="0 0 120 120" aria-hidden="true">
                          <circle cx="60" cy="60" r="52" />
                          <circle
                            className="progress"
                            cx="60"
                            cy="60"
                            r="52"
                            style={{
                              strokeDashoffset:
                                327 - 327 * (countdown / 10),
                            }}
                          />
                        </svg>
                        <div>
                          <strong>{countdown}</strong>
                          <span>초</span>
                        </div>
                      </div>
                      <div className="fall-copy">
                        <span className="alert-kicker">
                          <TriangleAlert size={16} aria-hidden="true" />
                          쓰러짐 의심
                        </span>
                        <h2>누운 자세를 확인하고 있습니다</h2>
                        <p>
                          자세가 계속되면 기기 안전 알림을 생성합니다.
                          {manualScenario && " 현재는 기능 테스트입니다."}
                        </p>
                        <div className="fall-actions">
                          <button
                            onClick={() => resolveVerification("recovered")}
                          >
                            <Check size={16} aria-hidden="true" />
                            다시 일어남
                          </button>
                          <button
                            onClick={() => resolveVerification("false_positive")}
                          >
                            <X size={16} aria-hidden="true" />
                            오탐 취소
                          </button>
                          <button
                            className="urgent"
                            onClick={() => void finishEmergency()}
                          >
                            <Zap size={16} aria-hidden="true" />
                            즉시 알림
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {alertPhase === "alerted" && (
                    <div className="emergency-panel" role="alert">
                      <div className="emergency-icon">
                        <OctagonAlert size={34} aria-hidden="true" />
                      </div>
                      <span>SAFETY EVENT</span>
                      <h2>쓰러짐 의심 알림을 기록했습니다</h2>
                      <p>
                        10초간 자세가 지속되었습니다. 실제 현장에서는 관제
                        담당자의 최종 확인이 필요합니다.
                      </p>
                      <button
                        className="button button-light"
                        onClick={acknowledgeEmergency}
                      >
                        <CheckCircle2 size={17} aria-hidden="true" />
                        관제 확인 완료
                      </button>
                    </div>
                  )}

                  {alertPhase === "recovered" && (
                    <div className="recovery-banner" role="status">
                      <CheckCircle2 size={21} aria-hidden="true" />
                      <div>
                        <strong>10초 이내 상태 회복</strong>
                        <span>알림 없이 회복 이력만 저장했습니다.</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="camera-footer">
                  <div className="model-status">
                    <span
                      className={`model-dot state-${modelState}`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>
                        {modelState === "ready"
                          ? "MediaPipe Edge AI 준비됨"
                          : modelState === "loading"
                            ? "AI 모델 준비 중"
                            : "기기 내 AI 대기"}
                      </strong>
                      <span>
                        자세 · 얼굴 · 사물 분석 / 원본 영상 업로드 없음
                      </span>
                    </div>
                  </div>
                  {alertPhase === "idle" && (
                    <button className="test-button" onClick={runFallTest}>
                      <Play size={16} fill="currentColor" aria-hidden="true" />
                      10초 알림 흐름 테스트
                    </button>
                  )}
                </div>
              </section>

              <section className="metric-grid" aria-label="오늘의 순찰 현황">
                <article className="metric-card">
                  <div className="metric-icon green">
                    <UserRound size={19} aria-hidden="true" />
                  </div>
                  <div>
                    <span>현재 사람 감지</span>
                    <strong>{visionStats.people}<small>명</small></strong>
                  </div>
                  <span className="metric-caption">
                    {cameraState === "running" ? "실시간" : "카메라 대기"}
                  </span>
                </article>
                <article className="metric-card">
                  <div className="metric-icon blue">
                    <ScanLine size={19} aria-hidden="true" />
                  </div>
                  <div>
                    <span>현재 사물 감지</span>
                    <strong>{visionStats.objects}<small>개</small></strong>
                  </div>
                  <span className="metric-caption">경량 객체 인식</span>
                </article>
                <article className="metric-card">
                  <div className="metric-icon orange">
                    <BellRing size={19} aria-hidden="true" />
                  </div>
                  <div>
                    <span>오늘 안전 알림</span>
                    <strong>{emergencyCount}<small>건</small></strong>
                  </div>
                  <span className="metric-caption">10초 확인 완료</span>
                </article>
                <article className="metric-card">
                  <div className="metric-icon violet">
                    <CheckCircle2 size={19} aria-hidden="true" />
                  </div>
                  <div>
                    <span>오늘 상태 회복</span>
                    <strong>{recoveredCount}<small>건</small></strong>
                  </div>
                  <span className="metric-caption">알림 없이 기록</span>
                </article>
              </section>

              <section className="operation-row">
                <article className="notification-card">
                  <div className="notification-card-icon">
                    <Smartphone size={24} aria-hidden="true" />
                  </div>
                  <div>
                    <span className="eyebrow">DEVICE NOTIFICATION</span>
                    <h2>긴급 기기 알림을 먼저 켜주세요</h2>
                    <p>
                      10초 확인 후 이 휴대폰에 시스템 알림을 표시합니다.
                      iPhone은 홈 화면에 추가한 뒤 허용해 주세요.
                    </p>
                  </div>
                  <button
                    className={`button ${notificationPermission === "granted" ? "button-success" : "button-dark"}`}
                    onClick={enableNotifications}
                  >
                    {notificationPermission === "granted" ? (
                      <>
                        <Check size={17} aria-hidden="true" />
                        알림 켜짐
                      </>
                    ) : (
                      <>
                        <Bell size={17} aria-hidden="true" />
                        알림 허용
                      </>
                    )}
                  </button>
                </article>

                <article className="limitation-card">
                  <Info size={20} aria-hidden="true" />
                  <div>
                    <strong>현장 실증용 MVP</strong>
                    <p>
                      감지는 앱이 화면에 열려 있을 때만 동작합니다. 눕기·가림·
                      야간 환경에서 오탐이 발생할 수 있으며 생명안전 판단을
                      대신하지 않습니다.
                    </p>
                  </div>
                </article>
              </section>
            </>
          )}

          {view === "history" && (
            <>
              <div className="page-heading history-heading">
                <div>
                  <span className="eyebrow">
                    <FileClock size={14} aria-hidden="true" />
                    LOCAL EVENT LOG
                  </span>
                  <h1>안전 이벤트 이력</h1>
                  <p>
                    알림·회복·오탐 기록은 현재 기기에만 저장됩니다. 저장된
                    이미지는 이미 얼굴 익명화가 적용된 화면입니다.
                  </p>
                </div>
                {events.length > 0 && (
                  <button
                    className="button button-ghost"
                    onClick={() => {
                      persistEvents([]);
                      showToast("이 기기의 이벤트 이력을 비웠습니다.");
                    }}
                  >
                    <RotateCcw size={16} aria-hidden="true" />
                    이력 초기화
                  </button>
                )}
              </div>

              <section className="history-summary">
                <article>
                  <span>전체 이벤트</span>
                  <strong>{events.length}</strong>
                </article>
                <article>
                  <span>알림 발송</span>
                  <strong>{events.filter((event) => event.status === "emergency").length}</strong>
                </article>
                <article>
                  <span>상태 회복</span>
                  <strong>{events.filter((event) => event.status === "recovered").length}</strong>
                </article>
                <article>
                  <span>오탐·중단</span>
                  <strong>
                    {
                      events.filter(
                        (event) =>
                          event.status === "false_positive" ||
                          event.status === "interrupted",
                      ).length
                    }
                  </strong>
                </article>
              </section>

              <section className="history-list" aria-live="polite">
                {historyLoaded && events.length === 0 ? (
                  <div className="empty-history">
                    <div>
                      <History size={30} aria-hidden="true" />
                    </div>
                    <h2>아직 저장된 이벤트가 없습니다</h2>
                    <p>
                      실제 카메라 감지 또는 ‘10초 알림 흐름 테스트’를 실행하면
                      처리 과정이 여기에 남습니다.
                    </p>
                    <button
                      className="button button-primary"
                      onClick={() => {
                        setView("patrol");
                        setTimeout(runFallTest, 200);
                      }}
                    >
                      <Play size={16} fill="currentColor" aria-hidden="true" />
                      테스트 시작
                    </button>
                  </div>
                ) : (
                  events.map((event) => (
                    <article className={`event-card status-${event.status}`} key={event.id}>
                      <div className="event-visual">
                        {event.snapshot ? (
                          // The snapshot is generated only from the anonymized canvas.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={event.snapshot} alt="얼굴이 익명화된 이벤트 화면" />
                        ) : (
                          <div className="event-placeholder">
                            {eventIcon(event.status)}
                          </div>
                        )}
                        <span className="event-badge">
                          {eventIcon(event.status)}
                          {eventStatusLabel(event.status)}
                        </span>
                      </div>
                      <div className="event-body">
                        <div className="event-meta">
                          <span>
                            <MapPin size={14} aria-hidden="true" />
                            일반 외부 환경
                          </span>
                          <span>
                            <Clock3 size={14} aria-hidden="true" />
                            {formatDate(event.createdAt)} {formatTime(event.createdAt)}
                          </span>
                        </div>
                        <h2>{event.title}</h2>
                        <p>{event.detail}</p>
                        <div className="event-data">
                          <span>
                            <small>확인 시간</small>
                            <strong>{event.durationSeconds}초</strong>
                          </span>
                          <span>
                            <small>자세 신뢰도</small>
                            <strong>{Math.round(event.confidence * 100)}%</strong>
                          </span>
                          <span>
                            <small>기기 알림</small>
                            <strong>
                              {event.notification === "sent"
                                ? "발송됨"
                                : event.notification === "permission_needed"
                                  ? "권한 필요"
                                  : "발송 안 함"}
                            </strong>
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="event-chevron" size={20} aria-hidden="true" />
                    </article>
                  ))
                )}
              </section>
            </>
          )}

          {view === "guide" && (
            <>
              <div className="page-heading guide-heading">
                <div>
                  <span className="eyebrow">
                    <ShieldCheck size={14} aria-hidden="true" />
                    SAFE FIELD PILOT
                  </span>
                  <h1>안전한 현장 테스트 가이드</h1>
                  <p>
                    공개된 외부 환경에서는 촬영 사실을 알리고, 관제 담당자의
                    확인을 포함한 운영 절차가 필요합니다.
                  </p>
                </div>
              </div>

              <section className="guide-hero">
                <div className="guide-hero-copy">
                  <span className="guide-number">01</span>
                  <span className="eyebrow">START HERE</span>
                  <h2>휴대폰을 고정하고 전신이 보이게 테스트하세요.</h2>
                  <p>
                    첫 실증은 밝은 낮, 한 명, 약 2~4m 거리에서 시작하세요.
                    움직이는 카메라와 여러 사람이 겹치는 환경에서는 정확도가
                    낮아질 수 있습니다.
                  </p>
                  <button
                    className="button button-light"
                    onClick={() => setView("patrol")}
                  >
                    <Camera size={17} aria-hidden="true" />
                    순찰 화면으로 이동
                  </button>
                </div>
                <div className="guide-visual" aria-hidden="true">
                  <div className="guide-phone">
                    <span className="phone-camera" />
                    <div className="phone-screen">
                      <span className="person-outline" />
                      <span className="scan-corner top-left" />
                      <span className="scan-corner top-right" />
                      <span className="scan-corner bottom-left" />
                      <span className="scan-corner bottom-right" />
                      <small>FULL BODY · 2–4m</small>
                    </div>
                  </div>
                  <div className="distance-line">
                    <span />
                    <strong>2–4m</strong>
                    <span />
                  </div>
                </div>
              </section>

              <section className="guide-grid">
                <article>
                  <div className="guide-icon">
                    <Camera size={20} aria-hidden="true" />
                  </div>
                  <span>02 · 촬영 고지</span>
                  <h2>촬영 중임을 쉽게 알리기</h2>
                  <p>
                    로봇 또는 테스트 구역에 AI 안전 카메라 촬영 사실과 운영
                    주체, 문의 방법을 표시해야 합니다.
                  </p>
                </article>
                <article>
                  <div className="guide-icon">
                    <EyeOff size={20} aria-hidden="true" />
                  </div>
                  <span>03 · 최소 수집</span>
                  <h2>원본 영상은 저장하지 않기</h2>
                  <p>
                    이 MVP는 원본 영상을 서버로 전송하지 않습니다. 이력에는
                    익명화 화면과 상태 정보만 기기에 저장합니다.
                  </p>
                </article>
                <article>
                  <div className="guide-icon">
                    <UserRound size={20} aria-hidden="true" />
                  </div>
                  <span>04 · 사람의 확인</span>
                  <h2>AI 알림은 판단의 시작점</h2>
                  <p>
                    ‘쓰러짐 의심’ 알림 뒤 관제 담당자가 현장을 확인해야
                    합니다. 자동 신고나 구조 확정으로 사용하면 안 됩니다.
                  </p>
                </article>
              </section>

              <section className="system-flow">
                <div className="flow-heading">
                  <span className="eyebrow">PHYSICAL AI ROADMAP</span>
                  <h2>휴대폰 실증에서 순찰로봇 관제로</h2>
                </div>
                <div className="flow-steps">
                  <div>
                    <span className="flow-index">1</span>
                    <Smartphone size={22} aria-hidden="true" />
                    <strong>모바일 실증</strong>
                    <small>카메라 · 자세 분석</small>
                  </div>
                  <ChevronRight size={18} aria-hidden="true" />
                  <div>
                    <span className="flow-index">2</span>
                    <Bot size={22} aria-hidden="true" />
                    <strong>로봇 엣지 AI</strong>
                    <small>Jetson · ROS2 · IMU</small>
                  </div>
                  <ChevronRight size={18} aria-hidden="true" />
                  <div>
                    <span className="flow-index">3</span>
                    <BellRing size={22} aria-hidden="true" />
                    <strong>관제 웹푸시</strong>
                    <small>서버 · 이중 알림</small>
                  </div>
                  <ChevronRight size={18} aria-hidden="true" />
                  <div>
                    <span className="flow-index">4</span>
                    <ShieldCheck size={22} aria-hidden="true" />
                    <strong>현장 대응</strong>
                    <small>사람 확인 · 조치 기록</small>
                  </div>
                </div>
              </section>

              <section className="disclaimer-card">
                <TriangleAlert size={22} aria-hidden="true" />
                <div>
                  <strong>중요한 한계</strong>
                  <p>
                    이 프로그램은 연구·현장 검증용 프로토타입입니다. MediaPipe
                    자세 모델과 규칙 기반 휴리스틱은 낙상 여부를 의학적으로
                    판정하지 않으며, 긴급 신고 또는 생명안전 시스템을 대체하지
                    않습니다.
                  </p>
                </div>
              </section>
            </>
          )}
        </section>
      </div>

      <nav className="mobile-nav" aria-label="모바일 주요 메뉴">
        <button
          className={view === "patrol" ? "active" : ""}
          onClick={() => setView("patrol")}
        >
          <ScanLine size={20} aria-hidden="true" />
          <span>순찰</span>
        </button>
        <button
          className={view === "history" ? "active" : ""}
          onClick={() => setView("history")}
        >
          <History size={20} aria-hidden="true" />
          <span>이력</span>
          {events.length > 0 && <i>{events.length}</i>}
        </button>
        <button
          className={view === "guide" ? "active" : ""}
          onClick={() => setView("guide")}
        >
          <Settings2 size={20} aria-hidden="true" />
          <span>안내</span>
        </button>
      </nav>

      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          {toast}
        </div>
      )}
    </main>
  );
}
