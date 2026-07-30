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
  KeyRound,
  LockKeyhole,
  MapPin,
  MonitorUp,
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
  UploadCloud,
  UserRound,
  Video,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deleteEventClip,
  getEventClip,
  listEventClips,
  saveEventClip,
  updateEventClipUploadStatus,
} from "./clip-store";
import {
  EventRecordingError,
  startEventRecording,
  type EventRecordingResult,
  type EventRecordingSession,
} from "./event-recorder";
import {
  analyzeFallPose,
  createVerificationProgress,
  FALL_MAX_POSITIVE_GAP_MS,
  poseCenterDistance,
  type FallAnalysis,
  type PoseCenter,
  type PosePoint,
  type VerificationProgress,
  updateVerificationProgress,
} from "./fall-detection";

type AppView = "patrol" | "history" | "guide";
type CameraState = "idle" | "starting" | "running" | "error";
type ModelState = "idle" | "loading" | "ready" | "error";
type AlertPhase = "idle" | "verifying" | "alerted" | "recovered";
type EventStatus =
  | "emergency"
  | "recovered"
  | "false_positive"
  | "interrupted";
type ClipState =
  | "none"
  | "recording"
  | "local"
  | "uploading"
  | "uploaded"
  | "failed"
  | "unsupported";
type ControlConnectionState =
  | "checking"
  | "connected"
  | "disconnected"
  | "unavailable";

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
  people?: number;
  objects?: number;
  snapshot?: string;
  clipState?: ClipState;
  clipMimeType?: string;
  clipBytes?: number;
  clipDurationMs?: number;
  serverEventId?: string;
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
const SUSPECT_STABILITY_MS = 1_800;
const MIN_SUSPECT_SAMPLES = 6;
const MAX_CANDIDATE_DISTANCE = 0.16;
const RECOVERY_CANDIDATE_DISTANCE = 0.28;
const RECOVERY_STABILITY_MS = 850;
const LOST_TRACKING_MS = 1_100;
const MAX_VERIFICATION_WALL_MS = 20_000;
const PRIVACY_RESULT_MAX_AGE_MS = 650;
const STORAGE_KEY = "safebot-safety-events-v1";
const DEVICE_ID_KEY = "safebot-device-id-v1";
const PERSON_DETECTION_COLOR = "#ff4d5a";
const OBJECT_DETECTION_COLOR = "#7bd4ff";

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

function formatClipBytes(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function dataUrlToBlob(dataUrl?: string) {
  if (!dataUrl) return undefined;
  try {
    return await (await fetch(dataUrl)).blob();
  } catch {
    return undefined;
  }
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
  const [recordingState, setRecordingState] =
    useState<ClipState>("none");
  const [controlConnection, setControlConnection] =
    useState<ControlConnectionState>("checking");
  const [showControlLogin, setShowControlLogin] = useState(false);
  const [controlPassword, setControlPassword] = useState("");
  const [controlLoginError, setControlLoginError] = useState("");
  const [controlLoginBusy, setControlLoginBusy] = useState(false);
  const [selectedClip, setSelectedClip] = useState<{
    event: SafetyEvent;
    url: string;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement>(null);
  const recordingCanvasRef = useRef<HTMLCanvasElement>(null);
  const alertPopupRef = useRef<HTMLDivElement>(null);
  const pixelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef<Promise<void> | null>(null);
  const workerBusyRef = useRef(false);
  const latestResultRef = useRef<VisionResult | null>(null);
  const visionStatsRef = useRef<VisionStats>({
    people: 0,
    objects: 0,
    confidence: 0,
    latencyMs: 0,
  });
  const animationRef = useRef<number | null>(null);
  const inferenceRef = useRef<number | null>(null);
  const alertPhaseRef = useRef<AlertPhase>("idle");
  const verificationStartedRef = useRef<number | null>(null);
  const suspectStartedRef = useRef<number | null>(null);
  const suspectLastPositiveRef = useRef<number | null>(null);
  const suspectSamplesRef = useRef(0);
  const suspectCandidateRef = useRef<PoseCenter | null>(null);
  const uprightStartedRef = useRef<number | null>(null);
  const lastPositiveRef = useRef<number | null>(null);
  const verificationProgressRef = useRef<VerificationProgress>(
    createVerificationProgress(),
  );
  const verificationCandidateRef = useRef<PoseCenter | null>(null);
  const emergencyTriggeredRef = useRef(false);
  const manualScenarioRef = useRef(false);
  const recordingSessionRef = useRef<EventRecordingSession | null>(null);
  const eventUploadPromisesRef = useRef(
    new Map<string, Promise<boolean>>(),
  );
  const syncingClipsRef = useRef(false);
  const eventsRef = useRef<SafetyEvent[]>([]);
  const deviceIdRef = useRef("모바일 순찰 01");
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
      clip?: Pick<
        SafetyEvent,
        "clipState" | "clipMimeType" | "clipBytes" | "clipDurationMs"
      >,
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
        people: visionStatsRef.current.people,
        objects: visionStatsRef.current.objects,
        snapshot,
        ...clip,
      };
      persistEvents([event, ...eventsRef.current].slice(0, 16));
      return event;
    },
    [captureSnapshot, persistEvents],
  );

  const patchEvent = useCallback(
    (eventId: string, patch: Partial<SafetyEvent>) => {
      persistEvents(
        eventsRef.current.map((event) =>
          event.id === eventId ? { ...event, ...patch } : event,
        ),
      );
    },
    [persistEvents],
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

  const startVerificationRecording = useCallback(() => {
    const source = canvasRef.current;
    const target = recordingCanvasRef.current;
    if (
      !source ||
      !target ||
      source.width <= 0 ||
      source.height <= 0 ||
      !streamRef.current
    ) {
      setRecordingState("unsupported");
      return;
    }

    void recordingSessionRef.current?.discard();
    recordingSessionRef.current = null;

    const scale = Math.min(1, 640 / source.width);
    target.width = Math.max(1, Math.round(source.width * scale));
    target.height = Math.max(1, Math.round(source.height * scale));
    const context = target.getContext("2d", { alpha: false });
    if (!context) {
      setRecordingState("unsupported");
      return;
    }
    // Start from an opaque safe frame. The render loop replaces this only
    // with a verified redacted frame or full-frame pixelation.
    context.fillStyle = "#07150f";
    context.fillRect(0, 0, target.width, target.height);

    try {
      recordingSessionRef.current = startEventRecording(target, {
        frameRate: 12,
        maxDurationMs: FALL_CONFIRMATION_MS,
        videoBitsPerSecond: 1_000_000,
        timesliceMs: 1_000,
      });
      setRecordingState("recording");
    } catch (error) {
      setRecordingState(
        error instanceof EventRecordingError &&
          error.code === "UNSUPPORTED"
          ? "unsupported"
          : "failed",
      );
    }
  }, []);

  const discardVerificationRecording = useCallback(() => {
    const session = recordingSessionRef.current;
    recordingSessionRef.current = null;
    setRecordingState("none");
    if (session) void session.discard();
  }, []);

  const finalizeVerificationRecording =
    useCallback(async (): Promise<EventRecordingResult | null> => {
      const session = recordingSessionRef.current;
      recordingSessionRef.current = null;
      if (!session) return null;

      try {
        const result = await session.finalize();
        setRecordingState("local");
        return result;
      } catch {
        setRecordingState("failed");
        return null;
      }
    }, []);

  const uploadEventToControl = useCallback(
    (event: SafetyEvent, clip: Blob) => {
      const existingUpload = eventUploadPromisesRef.current.get(event.id);
      if (existingUpload) return existingUpload;

      const upload = (async () => {
        patchEvent(event.id, { clipState: "uploading" });
        setRecordingState("uploading");
        await updateEventClipUploadStatus(event.id, "uploading");

        try {
          const form = new FormData();
          form.set(
            "meta",
            JSON.stringify({
              id: event.id,
              status: event.status,
              title: event.title,
              detail: event.detail,
              createdAt: event.createdAt,
              durationSeconds: event.durationSeconds,
              confidence: event.confidence,
              notification: event.notification,
              people: event.people,
              objects: event.objects,
              deviceId: deviceIdRef.current,
            }),
          );
          const extension = clip.type.includes("mp4") ? "mp4" : "webm";
          form.set("clip", clip, `${event.id}.${extension}`);
          const poster = await dataUrlToBlob(event.snapshot);
          if (poster) form.set("poster", poster, `${event.id}.jpg`);

          const response = await fetch("/api/events", {
            method: "POST",
            credentials: "same-origin",
            body: form,
          });
          if (response.status === 401) {
            setControlConnection("disconnected");
            throw new Error("관제 인증이 만료되었습니다.");
          }
          if (!response.ok) {
            throw new Error("관제 서버 업로드에 실패했습니다.");
          }

          const payload = (await response.json()) as {
            event?: { id?: string };
          };
          await updateEventClipUploadStatus(event.id, "uploaded");
          patchEvent(event.id, {
            clipState: "uploaded",
            serverEventId: payload.event?.id || event.id,
          });
          setRecordingState("uploaded");
          return true;
        } catch {
          await updateEventClipUploadStatus(event.id, "failed");
          patchEvent(event.id, { clipState: "failed" });
          setRecordingState("failed");
          return false;
        }
      })();

      eventUploadPromisesRef.current.set(event.id, upload);
      void upload.finally(() => {
        if (eventUploadPromisesRef.current.get(event.id) === upload) {
          eventUploadPromisesRef.current.delete(event.id);
        }
      });
      return upload;
    },
    [patchEvent],
  );

  const storeConfirmedClip = useCallback(
    async (event: SafetyEvent, recording: EventRecordingResult) => {
      const saved = await saveEventClip({
        eventId: event.id,
        blob: recording.blob,
        durationMs: recording.durationMs,
        createdAt: new Date(event.createdAt).getTime(),
        uploadStatus:
          controlConnection === "connected" ? "pending" : "local-only",
      });
      if (!saved.ok) {
        patchEvent(event.id, { clipState: "failed" });
        setRecordingState("failed");
        return false;
      }

      for (const evictedId of saved.value.evictedEventIds) {
        patchEvent(evictedId, {
          clipState: "none",
          clipBytes: undefined,
          clipDurationMs: undefined,
        });
      }
      patchEvent(event.id, {
        clipState: "local",
        clipMimeType: recording.mimeType,
        clipBytes: recording.bytes,
        clipDurationMs: recording.durationMs,
      });

      if (controlConnection === "connected") {
        return uploadEventToControl(
          { ...event, clipState: "local" },
          recording.blob,
        );
      }
      setRecordingState("local");
      return true;
    },
    [controlConnection, patchEvent, uploadEventToControl],
  );

  const syncPendingClips = useCallback(async () => {
    if (syncingClipsRef.current) return;
    syncingClipsRef.current = true;
    try {
      const listed = await listEventClips();
      if (!listed.ok) return;
      for (const metadata of listed.value) {
        if (metadata.uploadStatus === "uploaded") continue;
        const event = eventsRef.current.find(
          (candidate) => candidate.id === metadata.eventId,
        );
        if (!event || event.status !== "emergency") continue;
        const stored = await getEventClip(event.id);
        if (!stored.ok || !stored.value) continue;
        await uploadEventToControl(event, stored.value.blob);
      }
    } finally {
      syncingClipsRef.current = false;
    }
  }, [uploadEventToControl]);

  const resetDetectionState = useCallback(() => {
    verificationStartedRef.current = null;
    suspectStartedRef.current = null;
    suspectLastPositiveRef.current = null;
    suspectSamplesRef.current = 0;
    suspectCandidateRef.current = null;
    uprightStartedRef.current = null;
    lastPositiveRef.current = null;
    verificationProgressRef.current = createVerificationProgress();
    verificationCandidateRef.current = null;
    emergencyTriggeredRef.current = false;
    manualScenarioRef.current = false;
    setManualScenario(false);
    setCountdown(10);
    setFallConfidence(0);
  }, []);

  const finishEmergency = useCallback(async () => {
    if (emergencyTriggeredRef.current) return;
    emergencyTriggeredRef.current = true;
    const duration =
      manualScenarioRef.current && verificationStartedRef.current
        ? Math.max(
            10,
            Math.round(
              (performance.now() - verificationStartedRef.current) / 1000,
            ),
          )
        : Math.max(
            10,
            Math.round(
              verificationProgressRef.current.confirmedMs / 1000,
            ),
          );
    setPhase("alerted");
    setCountdown(0);

    const [notificationSent, recording] = await Promise.all([
      sendDeviceNotification(),
      finalizeVerificationRecording(),
    ]);
    const permission =
      "Notification" in window ? Notification.permission : "denied";

    const event = addEvent(
      "emergency",
      "쓰러짐 의심 · 관제 확인 필요",
      recording
        ? "누운 자세가 10초간 연속 감지되어 익명화된 무음 영상과 안전 알림을 기록했습니다."
        : "누운 자세가 10초간 연속 감지되어 안전 알림을 기록했습니다. 이 기기에서는 영상 녹화를 완료하지 못했습니다.",
      duration,
      fallConfidence || 0.82,
      notificationSent
        ? "sent"
        : permission === "granted"
          ? "not_sent"
          : "permission_needed",
      recording
        ? {
            clipState: "local",
            clipMimeType: recording.mimeType,
            clipBytes: recording.bytes,
            clipDurationMs: recording.durationMs,
          }
        : {
            clipState:
              recordingState === "unsupported" ? "unsupported" : "failed",
          },
    );
    if (recording) void storeConfirmedClip(event, recording);
    showToast(
      recording
        ? controlConnection === "connected"
          ? "10초 영상을 저장하고 관제센터로 전송합니다."
          : "10초 영상을 이 기기에 저장했습니다."
        : notificationSent
          ? "기기 알림을 발송했습니다."
          : "이벤트를 기록했습니다. 알림 권한을 확인해 주세요.",
    );
  }, [
    addEvent,
    controlConnection,
    fallConfidence,
    finalizeVerificationRecording,
    recordingState,
    sendDeviceNotification,
    setPhase,
    showToast,
    storeConfirmedClip,
  ]);

  const beginVerification = useCallback(
    (
      confidence: number,
      isManual = false,
      candidateCenter: PoseCenter | null = null,
    ) => {
      if (alertPhaseRef.current !== "idle") return;
      const now = performance.now();
      verificationStartedRef.current = now;
      lastPositiveRef.current = now;
      verificationProgressRef.current = createVerificationProgress(
        isManual ? null : now,
      );
      verificationCandidateRef.current = candidateCenter;
      emergencyTriggeredRef.current = false;
      manualScenarioRef.current = isManual;
      setManualScenario(isManual);
      setFallConfidence(confidence);
      setCountdown(10);
      setPhase("verifying");
      startVerificationRecording();
    },
    [setPhase, startVerificationRecording],
  );

  const resolveVerification = useCallback(
    (status: "recovered" | "false_positive" | "interrupted") => {
      if (
        alertPhaseRef.current !== "verifying" ||
        emergencyTriggeredRef.current
      ) {
        return;
      }
      discardVerificationRecording();
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
      discardVerificationRecording,
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
      const emptyAnalysis: FallAnalysis = {
        isLying: false,
        isUpright: false,
        confidence: 0,
        center: null,
      };
      const strongestAnalysis = analyses.reduce<FallAnalysis>(
        (best, current) =>
          current.confidence > best.confidence ? current : best,
        emptyAnalysis,
      );
      const strongestLying = analyses
        .filter((analysis) => analysis.isLying && analysis.center)
        .reduce<FallAnalysis | null>(
          (best, current) =>
            !best || current.confidence > best.confidence ? current : best,
          null,
        );

      let closestTrackedLying: FallAnalysis | null = null;
      const continuityCenter =
        alertPhaseRef.current === "verifying"
          ? verificationCandidateRef.current
          : alertPhaseRef.current === "idle"
            ? suspectCandidateRef.current
            : null;
      if (continuityCenter) {
        let closestDistance = MAX_CANDIDATE_DISTANCE;
        for (const analysis of analyses) {
          if (!analysis.isLying || !analysis.center) continue;
          const distance = poseCenterDistance(
            continuityCenter,
            analysis.center,
          );
          if (distance <= closestDistance) {
            closestDistance = distance;
            closestTrackedLying = analysis;
          }
        }
      }
      const activeLying =
        alertPhaseRef.current === "verifying" &&
        verificationCandidateRef.current
          ? closestTrackedLying
          : alertPhaseRef.current === "idle" &&
              suspectCandidateRef.current
            ? closestTrackedLying ?? strongestLying
            : strongestLying;

      const nextVisionStats = {
        people,
        objects: nonPeople,
        confidence:
          strongestLying?.confidence ?? strongestAnalysis.confidence,
        latencyMs: result.latencyMs,
      };
      visionStatsRef.current = nextVisionStats;
      setVisionStats(nextVisionStats);

      if (manualScenarioRef.current) return;

      const now = performance.now();
      if (activeLying?.center) {
        lastPositiveRef.current = now;
        uprightStartedRef.current = null;
        setFallConfidence(activeLying.confidence);

        if (alertPhaseRef.current === "verifying") {
          if (verificationCandidateRef.current) {
            verificationCandidateRef.current = {
              x:
                verificationCandidateRef.current.x * 0.8 +
                activeLying.center.x * 0.2,
              y:
                verificationCandidateRef.current.y * 0.8 +
                activeLying.center.y * 0.2,
            };
          }

          verificationProgressRef.current = updateVerificationProgress(
            verificationProgressRef.current,
            now,
            true,
          );
          const verifiedMs =
            verificationProgressRef.current.confirmedMs;
          setCountdown(
            Math.max(
              0,
              Math.ceil((FALL_CONFIRMATION_MS - verifiedMs) / 1000),
            ),
          );
          if (verifiedMs >= FALL_CONFIRMATION_MS) {
            void finishEmergency();
          }
          return;
        }

        if (alertPhaseRef.current !== "idle") return;

        const previousCandidate = suspectCandidateRef.current;
        const previousPositive = suspectLastPositiveRef.current;
        const startsNewCandidate =
          suspectStartedRef.current === null ||
          previousPositive === null ||
          now - previousPositive > FALL_MAX_POSITIVE_GAP_MS ||
          poseCenterDistance(previousCandidate, activeLying.center) >
            MAX_CANDIDATE_DISTANCE;

        if (startsNewCandidate) {
          suspectStartedRef.current = now;
          suspectSamplesRef.current = 1;
          suspectCandidateRef.current = activeLying.center;
        } else {
          suspectSamplesRef.current += 1;
          if (previousCandidate) {
            suspectCandidateRef.current = {
              x: previousCandidate.x * 0.75 + activeLying.center.x * 0.25,
              y: previousCandidate.y * 0.75 + activeLying.center.y * 0.25,
            };
          }
        }
        suspectLastPositiveRef.current = now;

        if (
          suspectStartedRef.current !== null &&
          now - suspectStartedRef.current >= SUSPECT_STABILITY_MS &&
          suspectSamplesRef.current >= MIN_SUSPECT_SAMPLES
        ) {
          beginVerification(
            activeLying.confidence,
            false,
            suspectCandidateRef.current,
          );
        }
        return;
      }

      suspectStartedRef.current = null;
      suspectLastPositiveRef.current = null;
      suspectSamplesRef.current = 0;
      suspectCandidateRef.current = null;
      if (alertPhaseRef.current !== "verifying") return;

      verificationProgressRef.current = updateVerificationProgress(
        verificationProgressRef.current,
        now,
        false,
      );
      const matchingUpright = analyses.some(
        (analysis) =>
          analysis.isUpright &&
          analysis.center &&
          (!verificationCandidateRef.current ||
            poseCenterDistance(
              verificationCandidateRef.current,
              analysis.center,
            ) <= RECOVERY_CANDIDATE_DISTANCE),
      );

      if (matchingUpright && uprightStartedRef.current === null) {
        uprightStartedRef.current = now;
      }
      if (
        matchingUpright &&
        uprightStartedRef.current !== null &&
        now - uprightStartedRef.current >= RECOVERY_STABILITY_MS
      ) {
        resolveVerification("recovered");
        return;
      }
      if (!matchingUpright) {
        uprightStartedRef.current = null;
        if (
          lastPositiveRef.current &&
          now - lastPositiveRef.current > LOST_TRACKING_MS
        ) {
          resolveVerification("interrupted");
        }
      }
    },
    [
      beginVerification,
      finishEmergency,
      resolveVerification,
    ],
  );

  useEffect(() => {
    handleVisionResultRef.current = handleVisionResult;
  }, [handleVisionResult]);

  useEffect(() => {
    if (alertPhase !== "verifying" && alertPhase !== "alerted") return;
    const frame = window.requestAnimationFrame(() => {
      alertPopupRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [alertPhase]);

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
      if (!pixelContext) return false;

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
      return true;
    },
    [],
  );

  const drawFullyPixelatedFrame = useCallback(
    (
      context: CanvasRenderingContext2D,
      video: HTMLVideoElement,
    ) => {
      const canvas = context.canvas;
      const privacyWidth = 64;
      const privacyHeight = Math.max(
        36,
        Math.round((canvas.height / canvas.width) * privacyWidth),
      );
      if (!pixelCanvasRef.current) {
        pixelCanvasRef.current = document.createElement("canvas");
      }
      const privacyCanvas = pixelCanvasRef.current;
      privacyCanvas.width = privacyWidth;
      privacyCanvas.height = privacyHeight;
      const privacyContext = privacyCanvas.getContext("2d");

      context.save();
      context.globalAlpha = 1;
      context.fillStyle = "#07150f";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (privacyContext) {
        privacyContext.drawImage(
          video,
          0,
          0,
          privacyCanvas.width,
          privacyCanvas.height,
        );
        context.imageSmoothingEnabled = false;
        context.drawImage(
          privacyCanvas,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      }
      context.restore();
      return Boolean(privacyContext);
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
      result &&
      performance.now() - result.timestamp < PRIVACY_RESULT_MAX_AGE_MS;
    let anonymizationApplied = false;

    if (result && resultIsFresh) {
      const faceBoxes = result.faces
        .map((face) => face.boundingBox)
        .filter((box): box is DetectionBox => Boolean(box));

      for (const faceBox of faceBoxes) {
        anonymizationApplied =
          drawPixelatedRegion(
            context,
            video,
            faceBox,
            result.frameWidth,
            result.frameHeight,
            0.34,
          ) || anonymizationApplied;
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
          anonymizationApplied =
            drawPixelatedRegion(
              context,
              video,
              poseFaceBox,
              result.frameWidth,
              result.frameHeight,
              0.55,
            ) || anonymizationApplied;
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
        anonymizationApplied =
          drawPixelatedRegion(
            context,
            video,
            headBox,
            result.frameWidth,
            result.frameHeight,
            0.2,
          ) || anonymizationApplied;
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
        const color = isPerson
          ? PERSON_DETECTION_COLOR
          : OBJECT_DETECTION_COLOR;
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

      for (const pose of result.poses) {
        context.strokeStyle = PERSON_DETECTION_COLOR;
        context.fillStyle = PERSON_DETECTION_COLOR;
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
      drawFullyPixelatedFrame(context, video);
    }

    // Only this fully rendered, face-anonymized frame is exposed to the
    // recorder. The original camera MediaStream is never recorded.
    const recordingCanvas = recordingCanvasRef.current;
    if (recordingCanvas) {
      const session = recordingSessionRef.current;
      const recordingIsActive =
        session?.state === "recording" || session?.state === "stopping";
      if (!recordingIsActive) {
        const scale = Math.min(1, 640 / canvas.width);
        const width = Math.max(1, Math.round(canvas.width * scale));
        const height = Math.max(1, Math.round(canvas.height * scale));
        if (
          recordingCanvas.width !== width ||
          recordingCanvas.height !== height
        ) {
          recordingCanvas.width = width;
          recordingCanvas.height = height;
        }
      }
      const recordingContext = recordingCanvas.getContext("2d", {
        alpha: false,
      });
      if (recordingContext) {
        if (resultIsFresh && anonymizationApplied) {
          recordingContext.drawImage(
            canvas,
            0,
            0,
            recordingCanvas.width,
            recordingCanvas.height,
          );
        } else {
          // A missing or stale privacy result must never expose a raw frame in
          // a persisted clip. Full-frame pixelation replaces every source
          // pixel until a verified face/person redaction is available.
          drawFullyPixelatedFrame(recordingContext, video);
        }
      }
    }
  }, [drawFullyPixelatedFrame, drawPixelatedRegion]);

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
      const emptyVisionStats = {
        people: 0,
        objects: 0,
        confidence: 0,
        latencyMs: 0,
      };
      visionStatsRef.current = emptyVisionStats;
      setVisionStats(emptyVisionStats);
      latestResultRef.current = null;

      if (
        alertPhaseRef.current === "verifying" &&
        reason
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

  const connectToControl = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!controlPassword) return;
      setControlLoginBusy(true);
      setControlLoginError("");
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: controlPassword }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string | { message?: string };
        };
        if (!response.ok) {
          const serverMessage =
            typeof payload.error === "string"
              ? payload.error
              : payload.error?.message;
          throw new Error(
            response.status === 429
              ? "로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요."
              : serverMessage || "관제 접속 코드를 확인해 주세요.",
          );
        }
        setControlPassword("");
        setControlConnection("connected");
        setShowControlLogin(false);
        showToast("관제센터에 연결했습니다. 대기 영상을 전송합니다.");
        void syncPendingClips();
      } catch (error) {
        setControlLoginError(
          error instanceof Error
            ? error.message
            : "관제센터에 연결하지 못했습니다.",
        );
      } finally {
        setControlLoginBusy(false);
      }
    },
    [controlPassword, showToast, syncPendingClips],
  );

  const openEventClip = useCallback(
    async (event: SafetyEvent) => {
      const stored = await getEventClip(event.id);
      if (stored.ok && stored.value) {
        setSelectedClip((current) => {
          if (current?.url.startsWith("blob:")) URL.revokeObjectURL(current.url);
          return {
            event,
            url: URL.createObjectURL(stored.value!.blob),
          };
        });
        return;
      }
      if (
        controlConnection === "connected" &&
        (event.clipState === "uploaded" || event.serverEventId)
      ) {
        setSelectedClip({
          event,
          url: `/api/events/${encodeURIComponent(event.serverEventId || event.id)}/clip`,
        });
        return;
      }
      showToast("이 기기에서 재생할 수 있는 영상이 없습니다.");
    },
    [controlConnection, showToast],
  );

  const closeEventClip = useCallback(() => {
    setSelectedClip((current) => {
      if (current?.url.startsWith("blob:")) URL.revokeObjectURL(current.url);
      return null;
    });
  }, []);

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
        now - startedAt > MAX_VERIFICATION_WALL_MS &&
        verificationProgressRef.current.confirmedMs < FALL_CONFIRMATION_MS
      ) {
        resolveVerification("interrupted");
        return;
      }
      if (
        !manualScenarioRef.current &&
        lastPositiveRef.current &&
        uprightStartedRef.current === null &&
        now - lastPositiveRef.current > LOST_TRACKING_MS
      ) {
        resolveVerification("interrupted");
        return;
      }
      if (
        !manualScenarioRef.current &&
        verificationProgressRef.current.negativeStartedAt !== null
      ) {
        verificationProgressRef.current = updateVerificationProgress(
          verificationProgressRef.current,
          now,
          false,
        );
      }
      const elapsed = manualScenarioRef.current
        ? now - startedAt
        : verificationProgressRef.current.confirmedMs;
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

      try {
        const savedDeviceId = window.localStorage.getItem(DEVICE_ID_KEY);
        if (savedDeviceId) {
          deviceIdRef.current = savedDeviceId;
        } else {
          const suffix = crypto.randomUUID().slice(0, 4).toUpperCase();
          deviceIdRef.current = `모바일 순찰 ${suffix}`;
          window.localStorage.setItem(DEVICE_ID_KEY, deviceIdRef.current);
        }
      } catch {
        deviceIdRef.current = "모바일 순찰 01";
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

    void fetch("/api/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (response.status === 503) {
          setControlConnection("unavailable");
          return;
        }
        const payload = (await response.json().catch(() => ({}))) as {
          authenticated?: boolean;
          configured?: boolean;
        };
        setControlConnection(
          payload.configured === false
            ? "unavailable"
            : payload.authenticated
              ? "connected"
              : "disconnected",
        );
      })
      .catch(() => setControlConnection("unavailable"));

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
    if (controlConnection === "connected" && historyLoaded) {
      void syncPendingClips();
    }
  }, [controlConnection, historyLoaded, syncPendingClips]);

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
      void recordingSessionRef.current?.discard();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [stopLoops],
  );

  useEffect(
    () => () => {
      if (selectedClip?.url.startsWith("blob:")) {
        URL.revokeObjectURL(selectedClip.url);
      }
    },
    [selectedClip],
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
          {controlConnection === "connected" ? (
            <Link
              className="control-connect-button is-connected"
              href="/control"
              aria-label="연결된 SAFEBOT 관제센터 열기"
            >
              <MonitorUp size={17} aria-hidden="true" />
              <span>관제센터</span>
            </Link>
          ) : (
            <button
              className="control-connect-button"
              onClick={() => {
                setControlLoginError("");
                setShowControlLogin(true);
              }}
              aria-label="SAFEBOT 관제센터 연결"
            >
              <LockKeyhole size={17} aria-hidden="true" />
              <span>관제 연결</span>
            </button>
          )}
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
            <Link className="side-nav-control" href="/control">
              <MonitorUp size={19} aria-hidden="true" />
              관제센터
              <span
                className={`control-link-dot state-${controlConnection}`}
                aria-hidden="true"
              />
            </Link>
          </div>

          <div className="side-status-card">
            <div className="side-status-icon">
              <EyeOff size={19} aria-hidden="true" />
            </div>
            <div>
              <strong>Privacy by default</strong>
              <p>원본·음성 없이 얼굴이 흐림 처리된 확정 영상만 저장합니다.</p>
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
                  <canvas
                    ref={recordingCanvasRef}
                    className="recording-canvas"
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
                        {recordingState === "recording" && (
                          <span className="recording-chip">
                            <span />
                            10초 익명화 녹화
                          </span>
                        )}
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
                        자세 · 얼굴 · 사물 분석 / 확정 시 익명화 영상만 저장
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
                    DEVICE EVENT LOG
                  </span>
                  <h1>안전 이벤트 이력</h1>
                  <p>
                    확정 이벤트는 얼굴이 흐림 처리된 무음 영상으로 최근 5건까지
                    이 기기에 저장됩니다. 관제 연결 시 비공개 서버에도 전송됩니다.
                  </p>
                </div>
                {events.length > 0 && (
                  <button
                    className="button button-ghost"
                    onClick={() => {
                      for (const event of eventsRef.current) {
                        void deleteEventClip(event.id);
                      }
                      persistEvents([]);
                      showToast("이 기기의 이벤트 이력과 영상을 비웠습니다.");
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
                        {(event.clipBytes || event.clipState === "uploaded") && (
                          <span className="event-video-badge">
                            <Video size={12} aria-hidden="true" />
                            10초
                          </span>
                        )}
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
                          <span>
                            <small>이벤트 영상</small>
                            <strong>
                              {event.clipState === "uploaded"
                                ? "관제 저장"
                                : event.clipBytes
                                  ? `기기 저장 ${formatClipBytes(event.clipBytes)}`
                                  : event.clipState === "unsupported"
                                    ? "미지원"
                                    : "없음"}
                            </strong>
                          </span>
                        </div>
                      </div>
                      {event.clipBytes || event.clipState === "uploaded" ? (
                        <button
                          className="event-play-button"
                          onClick={() => void openEventClip(event)}
                          aria-label={`${event.title} 10초 영상 보기`}
                        >
                          <Play
                            size={17}
                            fill="currentColor"
                            aria-hidden="true"
                          />
                          영상 보기
                        </button>
                      ) : (
                        <ChevronRight
                          className="event-chevron"
                          size={20}
                          aria-hidden="true"
                        />
                      )}
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
                  <h2>확정된 익명화 영상만 저장하기</h2>
                  <p>
                    원본과 음성은 저장하지 않습니다. 10초간 지속된 이벤트만
                    얼굴 흐림 화면으로 기기와 비공개 관제 서버에 보관합니다.
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

      {alertPhase === "verifying" && (
        <div
          ref={alertPopupRef}
          className="fall-panel"
          role="alertdialog"
          tabIndex={-1}
          aria-modal="false"
          aria-labelledby="fall-verification-title"
          aria-describedby="fall-verification-description"
        >
          <div
            className="countdown-ring"
            role="timer"
            aria-live="off"
            aria-label={`${countdown}초 남음`}
          >
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle cx="60" cy="60" r="52" />
              <circle
                className="progress"
                cx="60"
                cy="60"
                r="52"
                style={{
                  strokeDashoffset: 327 - 327 * (countdown / 10),
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
            <h2 id="fall-verification-title">
              누운 자세를 확인하고 있습니다
            </h2>
            <p id="fall-verification-description">
              자세가 계속되면 기기 안전 알림을 생성합니다.
              {recordingState === "recording" &&
                " 얼굴 흐림 화면을 무음으로 임시 녹화 중입니다."}
              {manualScenario && " 현재는 기능 테스트입니다."}
            </p>
            <div className="fall-actions">
              <button onClick={() => resolveVerification("recovered")}>
                <Check size={16} aria-hidden="true" />
                다시 일어남
              </button>
              <button onClick={() => resolveVerification("false_positive")}>
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
        <div
          ref={alertPopupRef}
          className="emergency-panel"
          role="alertdialog"
          tabIndex={-1}
          aria-modal="false"
          aria-labelledby="fall-alert-title"
          aria-describedby="fall-alert-description"
        >
          <div className="emergency-icon">
            <OctagonAlert size={34} aria-hidden="true" />
          </div>
          <span>SAFETY EVENT</span>
          <h2 id="fall-alert-title">쓰러짐 의심 알림을 기록했습니다</h2>
          <p id="fall-alert-description">
            10초간 자세가 지속되었습니다. 실제 현장에서는 관제 담당자의 최종
            확인이 필요합니다.
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

      {showControlLogin && (
        <div
          className="clip-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              setShowControlLogin(false);
            }
          }}
        >
          <form
            className="control-login-modal"
            onSubmit={connectToControl}
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-control-login-title"
          >
            <div className="clip-modal-heading">
              <div>
                <span className="eyebrow">SECURE CONTROL LINK</span>
                <h2 id="device-control-login-title">관제센터 연결</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowControlLogin(false)}
                aria-label="관제 연결 닫기"
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>
            <div className="control-login-description">
              <span>
                <UploadCloud size={21} aria-hidden="true" />
              </span>
              <div>
                <strong>확정된 10초 영상만 전송합니다</strong>
                <p>
                  원본과 음성은 전송하지 않으며, 얼굴 흐림 처리가 끝난 영상만
                  비공개 관제 이력에 7일간 보관합니다.
                </p>
              </div>
            </div>
            <label htmlFor="device-control-password">관제 접속 코드</label>
            <input
              id="device-control-password"
              type="password"
              value={controlPassword}
              onChange={(event) => setControlPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="접속 코드 입력"
              disabled={
                controlLoginBusy || controlConnection === "unavailable"
              }
              required
              autoFocus
            />
            {controlLoginError && (
              <div className="control-auth-error" role="alert">
                <TriangleAlert size={16} aria-hidden="true" />
                {controlLoginError}
              </div>
            )}
            {controlConnection === "unavailable" && (
              <div className="control-auth-error" role="status">
                <TriangleAlert size={16} aria-hidden="true" />
                관제 저장 서버가 아직 준비되지 않았습니다. 로컬 영상 저장은
                계속 사용할 수 있습니다.
              </div>
            )}
            <button
              className="button button-primary"
              type="submit"
              disabled={
                controlLoginBusy || controlConnection === "unavailable"
              }
            >
              <KeyRound size={17} aria-hidden="true" />
              {controlLoginBusy ? "연결 중" : "관제센터 연결"}
            </button>
            <Link href="/control">
              <MonitorUp size={15} aria-hidden="true" />
              관제센터 로그인 화면 열기
            </Link>
          </form>
        </div>
      )}

      {selectedClip && (
        <div
          className="clip-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeEventClip();
          }}
        >
          <section
            className="clip-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="local-clip-title"
          >
            <div className="clip-modal-heading">
              <div>
                <span className="eyebrow">ANONYMIZED EVENT CLIP</span>
                <h2 id="local-clip-title">{selectedClip.event.title}</h2>
              </div>
              <button
                className="icon-button"
                onClick={closeEventClip}
                aria-label="영상 닫기"
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>
            <video
              controls
              autoPlay
              playsInline
              preload="metadata"
              src={selectedClip.url}
              poster={selectedClip.event.snapshot}
            />
            <div className="clip-modal-meta">
              <span>
                <Clock3 size={14} aria-hidden="true" />
                {formatDate(selectedClip.event.createdAt)}{" "}
                {formatTime(selectedClip.event.createdAt)}
              </span>
              <span>
                <Video size={14} aria-hidden="true" />
                약{" "}
                {Math.max(
                  1,
                  Math.round(
                    (selectedClip.event.clipDurationMs || 10_000) / 1000,
                  ),
                )}
                초 · {formatClipBytes(selectedClip.event.clipBytes)}
              </span>
              <span>
                <EyeOff size={14} aria-hidden="true" />
                얼굴 흐림 · 음성 없음
              </span>
            </div>
          </section>
        </div>
      )}

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
        <Link href="/control">
          <MonitorUp size={20} aria-hidden="true" />
          <span>관제</span>
          {controlConnection === "connected" && (
            <b aria-label="관제센터 연결됨" />
          )}
        </Link>
      </nav>

      {toast &&
        alertPhase !== "verifying" &&
        alertPhase !== "alerted" && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          {toast}
        </div>
        )}
    </main>
  );
}
