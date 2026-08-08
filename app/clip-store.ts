const DATABASE_NAME = "safebot-event-clips";
const DATABASE_VERSION = 1;
const CLIP_STORE_NAME = "event-clips";
const CREATED_AT_INDEX = "created-at";

export const MAX_LOCAL_EVENT_CLIPS = 5;
export const MAX_LOCAL_EVENT_CLIP_BYTES = 50 * 1024 * 1024;

export type EventClipUploadStatus =
  | "local-only"
  | "pending"
  | "uploading"
  | "uploaded"
  | "failed";

export type EventClipMetadata = {
  eventId: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  mimeType: string;
  size: number;
  uploadStatus: EventClipUploadStatus;
};

export type StoredEventClip = EventClipMetadata & {
  blob: Blob;
};

export type SaveEventClipInput = {
  eventId: string;
  blob: Blob;
  durationMs: number;
  createdAt?: number;
  uploadStatus?: EventClipUploadStatus;
};

export type ClipStoreFailureReason =
  | "unsupported"
  | "invalid-input"
  | "clip-too-large"
  | "quota-exceeded"
  | "storage-error";

export type ClipStoreResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: ClipStoreFailureReason;
      message: string;
    };

export type SaveEventClipResult = {
  clip: EventClipMetadata;
  evictedEventIds: string[];
};

let databasePromise: Promise<IDBDatabase> | null = null;

function isBlobLike(value: unknown): value is Blob {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Blob;
  return (
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    typeof candidate.arrayBuffer === "function"
  );
}

function getErrorName(error: unknown) {
  return (
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      typeof error.name === "string" &&
      error.name) ||
    ""
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "브라우저의 영상 저장소를 사용할 수 없습니다.";
}

function storageFailure(error: unknown): ClipStoreResult<never> {
  const name = getErrorName(error);
  if (name === "QuotaExceededError") {
    return {
      ok: false,
      reason: "quota-exceeded",
      message: "기기의 저장 공간이 부족해 영상을 보관하지 못했습니다.",
    };
  }
  return {
    ok: false,
    reason: "storage-error",
    message: getErrorMessage(error),
  };
}

function toMetadata(record: StoredEventClip): EventClipMetadata {
  return {
    eventId: record.eventId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    durationMs: record.durationMs,
    mimeType: record.mimeType,
    size: record.size,
    uploadStatus: record.uploadStatus,
  };
}

export function isEventClipStorageSupported() {
  return typeof globalThis.indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  if (!isEventClipStorageSupported()) {
    return Promise.reject(
      new DOMException("IndexedDB is unavailable.", "NotSupportedError"),
    );
  }

  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CLIP_STORE_NAME)) {
        const store = database.createObjectStore(CLIP_STORE_NAME, {
          keyPath: "eventId",
        });
        store.createIndex(CREATED_AT_INDEX, "createdAt");
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(
        new DOMException(
          "Another SAFEBOT tab is blocking the clip database.",
          "InvalidStateError",
        ),
      );
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });

  return databasePromise;
}

async function withDatabase<T>(
  operation: (database: IDBDatabase) => Promise<T>,
): Promise<ClipStoreResult<T>> {
  if (!isEventClipStorageSupported()) {
    return {
      ok: false,
      reason: "unsupported",
      message: "이 브라우저는 기기 내 영상 저장을 지원하지 않습니다.",
    };
  }

  try {
    return { ok: true, value: await operation(await openDatabase()) };
  } catch (error) {
    return storageFailure(error);
  }
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new DOMException("Clip transaction aborted.", "AbortError"),
      );
    transaction.onerror = () => {
      // The abort handler reports the final transaction error.
    };
  });
}

export async function saveEventClip(
  input: SaveEventClipInput,
): Promise<ClipStoreResult<SaveEventClipResult>> {
  const eventId = input.eventId.trim();
  if (
    !eventId ||
    !isBlobLike(input.blob) ||
    input.blob.size <= 0 ||
    !Number.isFinite(input.durationMs) ||
    input.durationMs <= 0
  ) {
    return {
      ok: false,
      reason: "invalid-input",
      message: "이벤트 ID, 영상, 녹화 시간을 확인해주세요.",
    };
  }
  if (input.blob.size > MAX_LOCAL_EVENT_CLIP_BYTES) {
    return {
      ok: false,
      reason: "clip-too-large",
      message: "영상 한 건이 기기 내 보관 한도(50MB)를 초과했습니다.",
    };
  }

  const now = Date.now();
  const createdAt =
    typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
      ? input.createdAt
      : now;
  const record: StoredEventClip = {
    eventId,
    blob: input.blob,
    durationMs: Math.round(input.durationMs),
    createdAt,
    updatedAt: now,
    mimeType: input.blob.type || "application/octet-stream",
    size: input.blob.size,
    uploadStatus: input.uploadStatus ?? "local-only",
  };

  return withDatabase(
    (database) =>
      new Promise<SaveEventClipResult>((resolve, reject) => {
        const transaction = database.transaction(
          CLIP_STORE_NAME,
          "readwrite",
        );
        const store = transaction.objectStore(CLIP_STORE_NAME);
        const getAllRequest = store.getAll();
        let evictedEventIds: string[] = [];

        getAllRequest.onerror = () => {
          reject(getAllRequest.error);
          transaction.abort();
        };
        getAllRequest.onsuccess = () => {
          const existing = (getAllRequest.result as StoredEventClip[])
            .filter((clip) => clip.eventId !== eventId)
            .sort(
              (first, second) =>
                second.createdAt - first.createdAt ||
                second.updatedAt - first.updatedAt,
            );
          const keptEventIds = new Set([eventId]);
          let keptBytes = record.size;
          let keptCount = 1;

          for (const clip of existing) {
            const clipSize =
              Number.isFinite(clip.size) && clip.size >= 0
                ? clip.size
                : clip.blob.size;
            if (
              keptCount < MAX_LOCAL_EVENT_CLIPS &&
              keptBytes + clipSize <= MAX_LOCAL_EVENT_CLIP_BYTES
            ) {
              keptEventIds.add(clip.eventId);
              keptBytes += clipSize;
              keptCount += 1;
            }
          }

          evictedEventIds = existing
            .filter((clip) => !keptEventIds.has(clip.eventId))
            .map((clip) => clip.eventId);

          store.put(record);
          for (const oldEventId of evictedEventIds) {
            store.delete(oldEventId);
          }
        };

        transaction.oncomplete = () =>
          resolve({
            clip: toMetadata(record),
            evictedEventIds,
          });
        transaction.onabort = () =>
          reject(
            transaction.error ??
              new DOMException("Clip transaction aborted.", "AbortError"),
          );
        transaction.onerror = () => {
          // The abort handler reports the final transaction error.
        };
      }),
  );
}

export async function getEventClip(
  eventId: string,
): Promise<ClipStoreResult<StoredEventClip | null>> {
  const key = eventId.trim();
  if (!key) {
    return {
      ok: false,
      reason: "invalid-input",
      message: "조회할 이벤트 ID가 없습니다.",
    };
  }

  return withDatabase(async (database) => {
    const transaction = database.transaction(CLIP_STORE_NAME, "readonly");
    const result = await requestValue(
      transaction.objectStore(CLIP_STORE_NAME).get(key),
    );
    return (result as StoredEventClip | undefined) ?? null;
  });
}

export async function listEventClips(): Promise<
  ClipStoreResult<EventClipMetadata[]>
> {
  return withDatabase(async (database) => {
    const transaction = database.transaction(CLIP_STORE_NAME, "readonly");
    const records = (await requestValue(
      transaction.objectStore(CLIP_STORE_NAME).getAll(),
    )) as StoredEventClip[];
    return records
      .sort(
        (first, second) =>
          second.createdAt - first.createdAt ||
          second.updatedAt - first.updatedAt,
      )
      .map(toMetadata);
  });
}

export async function deleteEventClip(
  eventId: string,
): Promise<ClipStoreResult<void>> {
  const key = eventId.trim();
  if (!key) {
    return {
      ok: false,
      reason: "invalid-input",
      message: "삭제할 이벤트 ID가 없습니다.",
    };
  }

  return withDatabase(async (database) => {
    const transaction = database.transaction(CLIP_STORE_NAME, "readwrite");
    transaction.objectStore(CLIP_STORE_NAME).delete(key);
    await transactionDone(transaction);
  });
}

export async function updateEventClipUploadStatus(
  eventId: string,
  uploadStatus: EventClipUploadStatus,
): Promise<ClipStoreResult<EventClipMetadata | null>> {
  const key = eventId.trim();
  if (!key) {
    return {
      ok: false,
      reason: "invalid-input",
      message: "상태를 변경할 이벤트 ID가 없습니다.",
    };
  }

  return withDatabase(
    (database) =>
      new Promise<EventClipMetadata | null>((resolve, reject) => {
        const transaction = database.transaction(
          CLIP_STORE_NAME,
          "readwrite",
        );
        const store = transaction.objectStore(CLIP_STORE_NAME);
        const getRequest = store.get(key);
        let updatedRecord: StoredEventClip | null = null;

        getRequest.onerror = () => {
          reject(getRequest.error);
          transaction.abort();
        };
        getRequest.onsuccess = () => {
          const existing = getRequest.result as StoredEventClip | undefined;
          if (!existing) return;
          updatedRecord = {
            ...existing,
            uploadStatus,
            updatedAt: Date.now(),
          };
          store.put(updatedRecord);
        };
        transaction.oncomplete = () =>
          resolve(updatedRecord ? toMetadata(updatedRecord) : null);
        transaction.onabort = () =>
          reject(
            transaction.error ??
              new DOMException("Clip transaction aborted.", "AbortError"),
          );
        transaction.onerror = () => {
          // The abort handler reports the final transaction error.
        };
      }),
  );
}
