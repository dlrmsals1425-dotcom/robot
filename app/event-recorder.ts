export const EVENT_RECORDING_MAX_DURATION_MS = 10_000;

export const EVENT_RECORDING_MIME_TYPES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1.4D401E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

export type EventRecordingErrorCode =
  | "UNSUPPORTED"
  | "INVALID_CANVAS"
  | "START_FAILED"
  | "RECORDER_FAILED"
  | "EMPTY_RECORDING"
  | "DISCARDED";

export class EventRecordingError extends Error {
  readonly code: EventRecordingErrorCode;
  readonly cause?: unknown;

  constructor(
    code: EventRecordingErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EventRecordingError";
    this.code = code;
    this.cause = cause;
  }
}

export type EventRecordingOptions = {
  /**
   * Frames per second requested from the caller-owned anonymized canvas.
   * The helper never reads from or records the camera's original MediaStream.
   */
  frameRate?: number;
  /**
   * Recording automatically stops at this limit. Values above ten seconds are
   * capped at EVENT_RECORDING_MAX_DURATION_MS.
   */
  maxDurationMs?: number;
  videoBitsPerSecond?: number;
  /**
   * Smaller chunks make finalization more reliable on mobile Safari.
   */
  timesliceMs?: number;
};

export type EventRecordingResult = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  bytes: number;
  width: number;
  height: number;
  frameRate: number;
  startedAt: number;
  endedAt: number;
};

export type EventRecordingState =
  | "recording"
  | "stopping"
  | "finalized"
  | "discarded"
  | "failed";

export type EventRecordingSession = {
  readonly mimeType: string;
  readonly startedAt: number;
  readonly maxDurationMs: number;
  readonly state: EventRecordingState;
  /**
   * Stops early when necessary and resolves to the same result after the
   * automatic duration limit has already stopped the recorder.
   */
  finalize(): Promise<EventRecordingResult>;
  /**
   * Stops recording, drops collected chunks, and is safe to call repeatedly.
   * A discard requested while finalization is pending takes precedence.
   */
  discard(): Promise<void>;
};

export type EventRecordingSupport = {
  supported: boolean;
  preferredMimeType: string | null;
  reason: string | null;
};

type CaptureStreamCanvas = HTMLCanvasElement & {
  captureStream?: (frameRate?: number) => MediaStream;
};

type NormalizedOptions = {
  frameRate: number;
  maxDurationMs: number;
  videoBitsPerSecond: number;
  timesliceMs: number;
};

type StartedRecorder = {
  recorder: MediaRecorder;
  selectedMimeType: string;
};

const DEFAULT_FRAME_RATE = 12;
const DEFAULT_VIDEO_BITS_PER_SECOND = 1_200_000;
const DEFAULT_TIMESLICE_MS = 1_000;
const STOP_EVENT_FALLBACK_MS = 2_000;

function clampNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const normalized =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, normalized));
}

function normalizeOptions(
  options: EventRecordingOptions | undefined,
): NormalizedOptions {
  const maxDurationMs = Math.round(
    clampNumber(
      options?.maxDurationMs,
      EVENT_RECORDING_MAX_DURATION_MS,
      250,
      EVENT_RECORDING_MAX_DURATION_MS,
    ),
  );

  return {
    frameRate: clampNumber(options?.frameRate, DEFAULT_FRAME_RATE, 1, 30),
    maxDurationMs,
    videoBitsPerSecond: Math.round(
      clampNumber(
        options?.videoBitsPerSecond,
        DEFAULT_VIDEO_BITS_PER_SECOND,
        100_000,
        5_000_000,
      ),
    ),
    timesliceMs: Math.round(
      clampNumber(
        options?.timesliceMs,
        Math.min(DEFAULT_TIMESLICE_MS, maxDurationMs),
        100,
        maxDurationMs,
      ),
    ),
  };
}

function monotonicNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function getRecorderConstructor() {
  return typeof globalThis.MediaRecorder === "undefined"
    ? null
    : globalThis.MediaRecorder;
}

function supportsMimeType(
  Recorder: typeof MediaRecorder,
  mimeType: string,
) {
  if (typeof Recorder.isTypeSupported !== "function") return true;
  try {
    return Recorder.isTypeSupported(mimeType);
  } catch {
    return false;
  }
}

function preferredMimeType(Recorder: typeof MediaRecorder) {
  return (
    EVENT_RECORDING_MIME_TYPES.find((mimeType) =>
      supportsMimeType(Recorder, mimeType),
    ) ?? null
  );
}

export function getEventRecordingSupport(
  canvas: HTMLCanvasElement,
): EventRecordingSupport {
  const Recorder = getRecorderConstructor();
  if (!Recorder) {
    return {
      supported: false,
      preferredMimeType: null,
      reason: "이 브라우저는 MediaRecorder를 지원하지 않습니다.",
    };
  }

  if (
    typeof (canvas as CaptureStreamCanvas).captureStream !== "function"
  ) {
    return {
      supported: false,
      preferredMimeType: null,
      reason: "이 브라우저는 캔버스 영상 녹화를 지원하지 않습니다.",
    };
  }

  if (canvas.width <= 0 || canvas.height <= 0) {
    return {
      supported: false,
      preferredMimeType: preferredMimeType(Recorder),
      reason: "녹화 캔버스의 크기가 올바르지 않습니다.",
    };
  }

  return {
    supported: true,
    preferredMimeType: preferredMimeType(Recorder),
    reason: null,
  };
}

function startRecorder(
  Recorder: typeof MediaRecorder,
  stream: MediaStream,
  options: NormalizedOptions,
): StartedRecorder {
  let lastError: unknown;
  const recorderOptions = {
    videoBitsPerSecond: options.videoBitsPerSecond,
  };

  for (const mimeType of EVENT_RECORDING_MIME_TYPES) {
    if (!supportsMimeType(Recorder, mimeType)) continue;

    try {
      const recorder = new Recorder(stream, {
        ...recorderOptions,
        mimeType,
      });
      recorder.start(options.timesliceMs);
      return {
        recorder,
        selectedMimeType: recorder.mimeType || mimeType,
      };
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const recorder = new Recorder(stream, recorderOptions);
    recorder.start(options.timesliceMs);
    return {
      recorder,
      selectedMimeType: recorder.mimeType,
    };
  } catch (error) {
    throw new EventRecordingError(
      "START_FAILED",
      "이 기기에서 이벤트 영상 녹화를 시작하지 못했습니다.",
      error ?? lastError,
    );
  }
}

class BrowserEventRecordingSession implements EventRecordingSession {
  readonly startedAt: number;
  readonly maxDurationMs: number;

  private readonly recorder: MediaRecorder;
  private readonly stream: MediaStream;
  private readonly selectedMimeType: string;
  private readonly options: NormalizedOptions;
  private readonly width: number;
  private readonly height: number;
  private readonly startedMonotonicAt: number;
  private readonly outcome: Promise<EventRecordingResult | null>;

  private resolveOutcome!: (result: EventRecordingResult | null) => void;
  private rejectOutcome!: (error: EventRecordingError) => void;
  private chunks: Blob[] = [];
  private currentState: EventRecordingState = "recording";
  private discardRequested = false;
  private settled = false;
  private finalResult: EventRecordingResult | null = null;
  private stopRequestedAt: number | null = null;
  private stopRequestedMonotonicAt: number | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    recorder: MediaRecorder,
    stream: MediaStream,
    selectedMimeType: string,
    canvas: HTMLCanvasElement,
    options: NormalizedOptions,
    startedAt: number,
    startedMonotonicAt: number,
  ) {
    this.recorder = recorder;
    this.stream = stream;
    this.selectedMimeType = selectedMimeType;
    this.options = options;
    this.width = canvas.width;
    this.height = canvas.height;
    this.startedAt = startedAt;
    this.startedMonotonicAt = startedMonotonicAt;
    this.maxDurationMs = options.maxDurationMs;
    this.outcome = new Promise<EventRecordingResult | null>(
      (resolve, reject) => {
        this.resolveOutcome = resolve;
        this.rejectOutcome = reject;
      },
    );

    this.recorder.addEventListener("dataavailable", this.handleDataAvailable);
    this.recorder.addEventListener("error", this.handleError);
    this.recorder.addEventListener("stop", this.handleStop);

    this.durationTimer = setTimeout(() => {
      this.beginStop(false);
    }, this.maxDurationMs);
  }

  get mimeType() {
    return this.recorder.mimeType || this.selectedMimeType;
  }

  get state() {
    return this.currentState;
  }

  async finalize() {
    if (this.currentState === "discarded" || this.discardRequested) {
      throw new EventRecordingError(
        "DISCARDED",
        "폐기된 이벤트 영상은 완료할 수 없습니다.",
      );
    }

    if (this.currentState === "finalized" && this.finalResult) {
      return this.finalResult;
    }

    this.beginStop(false);
    const result = await this.outcome;
    if (!result) {
      throw new EventRecordingError(
        "DISCARDED",
        "이벤트 영상이 저장 전에 폐기되었습니다.",
      );
    }
    return result;
  }

  async discard() {
    if (this.currentState === "discarded") return;

    this.discardRequested = true;
    this.chunks = [];

    if (this.currentState === "finalized") {
      this.finalResult = null;
      this.currentState = "discarded";
      return;
    }

    if (this.currentState === "failed") {
      try {
        await this.outcome;
      } catch {
        // Discard is deliberately idempotent and does not surface old failures.
      }
      return;
    }

    this.beginStop(true);
    try {
      await this.outcome;
    } catch {
      // The tracks and chunks are still cleaned up by fail().
    }
  }

  private readonly handleDataAvailable = (event: BlobEvent) => {
    if (
      !this.discardRequested &&
      !this.settled &&
      event.data &&
      event.data.size > 0
    ) {
      this.chunks.push(event.data);
    }
  };

  private readonly handleError = (event: Event) => {
    const recorderError = (event as Event & { error?: unknown }).error;
    this.fail(
      new EventRecordingError(
        "RECORDER_FAILED",
        "이벤트 영상 녹화 중 브라우저 오류가 발생했습니다.",
        recorderError,
      ),
    );
  };

  private readonly handleStop = () => {
    if (this.stopRequestedAt === null) {
      this.stopRequestedAt = Date.now();
      this.stopRequestedMonotonicAt = monotonicNow();
    }

    // Safari can enqueue its final dataavailable event at the end of the same
    // task. Settling on the following task prevents dropping that last chunk.
    setTimeout(() => {
      this.settleAfterStop();
    }, 0);
  };

  private beginStop(discard: boolean) {
    if (this.settled) return;
    if (discard) this.discardRequested = true;
    if (this.currentState === "stopping") return;

    this.currentState = "stopping";
    this.stopRequestedAt = Date.now();
    this.stopRequestedMonotonicAt = monotonicNow();
    this.clearDurationTimer();

    if (this.recorder.state === "inactive") {
      setTimeout(() => {
        this.settleAfterStop();
      }, 0);
      return;
    }

    if (!this.discardRequested) {
      try {
        this.recorder.requestData();
      } catch {
        // stop() still asks the recorder for its final dataavailable chunk.
      }
    }

    try {
      this.recorder.stop();
    } catch (error) {
      const stateAfterStopAttempt: string = this.recorder.state;
      if (stateAfterStopAttempt === "inactive") {
        setTimeout(() => {
          this.settleAfterStop();
        }, 0);
      } else {
        this.fail(
          new EventRecordingError(
            "RECORDER_FAILED",
            "이벤트 영상 녹화를 종료하지 못했습니다.",
            error,
          ),
        );
        return;
      }
    }

    this.stopFallbackTimer = setTimeout(() => {
      this.settleAfterStop();
    }, STOP_EVENT_FALLBACK_MS);
  }

  private settleAfterStop() {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();

    if (this.discardRequested) {
      this.chunks = [];
      this.finalResult = null;
      this.currentState = "discarded";
      this.resolveOutcome(null);
      return;
    }

    const mimeType =
      this.recorder.mimeType ||
      this.chunks.find((chunk) => chunk.type)?.type ||
      this.selectedMimeType ||
      "video/webm";
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];

    if (blob.size === 0) {
      this.currentState = "failed";
      this.rejectOutcome(
        new EventRecordingError(
          "EMPTY_RECORDING",
          "녹화된 이벤트 영상 데이터가 없습니다.",
        ),
      );
      return;
    }

    const endedAt = this.stopRequestedAt ?? Date.now();
    const endedMonotonicAt =
      this.stopRequestedMonotonicAt ?? monotonicNow();
    const result: EventRecordingResult = {
      blob,
      mimeType: blob.type || mimeType,
      durationMs: Math.max(
        0,
        Math.round(endedMonotonicAt - this.startedMonotonicAt),
      ),
      bytes: blob.size,
      width: this.width,
      height: this.height,
      frameRate: this.options.frameRate,
      startedAt: this.startedAt,
      endedAt,
    };

    this.finalResult = result;
    this.currentState = "finalized";
    this.resolveOutcome(result);
  }

  private fail(error: EventRecordingError) {
    if (this.settled) return;
    this.settled = true;
    this.currentState = "failed";
    this.chunks = [];
    this.cleanup();

    if (this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // Cleanup below is sufficient if the browser refuses stop().
      }
    }

    this.rejectOutcome(error);
  }

  private clearDurationTimer() {
    if (this.durationTimer !== null) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
  }

  private cleanup() {
    this.clearDurationTimer();
    if (this.stopFallbackTimer !== null) {
      clearTimeout(this.stopFallbackTimer);
      this.stopFallbackTimer = null;
    }

    this.recorder.removeEventListener(
      "dataavailable",
      this.handleDataAvailable,
    );
    this.recorder.removeEventListener("error", this.handleError);
    this.recorder.removeEventListener("stop", this.handleStop);
    this.stream.getTracks().forEach((track) => track.stop());
  }
}

/**
 * Records only the pixels already drawn to `canvas`. The caller owns the
 * anonymization/render loop and should supply a roughly 640px-wide canvas.
 */
export function startEventRecording(
  canvas: HTMLCanvasElement,
  options?: EventRecordingOptions,
): EventRecordingSession {
  const support = getEventRecordingSupport(canvas);
  if (!support.supported) {
    throw new EventRecordingError(
      canvas.width <= 0 || canvas.height <= 0
        ? "INVALID_CANVAS"
        : "UNSUPPORTED",
      support.reason ?? "이 기기에서 이벤트 영상 녹화를 지원하지 않습니다.",
    );
  }

  const Recorder = getRecorderConstructor();
  const captureStream = (canvas as CaptureStreamCanvas).captureStream;
  if (!Recorder || typeof captureStream !== "function") {
    throw new EventRecordingError(
      "UNSUPPORTED",
      "이 기기에서 이벤트 영상 녹화를 지원하지 않습니다.",
    );
  }

  const normalizedOptions = normalizeOptions(options);
  let stream: MediaStream;

  try {
    stream = captureStream.call(canvas, normalizedOptions.frameRate);
  } catch (error) {
    throw new EventRecordingError(
      "START_FAILED",
      "익명화 화면을 영상 스트림으로 만들지 못했습니다.",
      error,
    );
  }

  const audioTracks = stream.getAudioTracks();
  audioTracks.forEach((track) => {
    stream.removeTrack(track);
    track.stop();
  });

  const videoTracks = stream.getVideoTracks();
  if (videoTracks.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new EventRecordingError(
      "START_FAILED",
      "익명화 화면에서 녹화 가능한 영상 트랙을 만들지 못했습니다.",
    );
  }

  videoTracks.slice(1).forEach((track) => {
    stream.removeTrack(track);
    track.stop();
  });

  let startedRecorder: StartedRecorder;
  try {
    startedRecorder = startRecorder(Recorder, stream, normalizedOptions);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const startedAt = Date.now();
  const startedMonotonicAt = monotonicNow();

  return new BrowserEventRecordingSession(
    startedRecorder.recorder,
    stream,
    startedRecorder.selectedMimeType,
    canvas,
    normalizedOptions,
    startedAt,
    startedMonotonicAt,
  );
}
