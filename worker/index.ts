/** Cloudflare Worker entry point for SAFEBOT. */
import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  LIVE_ROOM?: DurableObjectNamespace;
  CONTROL_PASSWORD?: string;
  SESSION_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type EventStatus =
  | "emergency"
  | "recovered"
  | "false_positive"
  | "interrupted";

type NotificationStatus = "sent" | "not_sent" | "permission_needed";

type EventMeta = {
  id?: string;
  status: EventStatus;
  title: string;
  detail: string;
  createdAt: string;
  durationSeconds: number;
  confidence: number;
  notification: NotificationStatus;
  people?: number;
  objects?: number;
  deviceId?: string;
};

type EventRow = {
  id: string;
  status: EventStatus;
  title: string;
  detail: string;
  created_at: number;
  duration_seconds: number;
  confidence: number;
  notification: NotificationStatus;
  people: number | null;
  objects: number | null;
  device_id: string | null;
  clip_mime: string | null;
  clip_size: number | null;
  poster_mime: string | null;
  poster_size: number | null;
  media_bytes: number;
  clip_sha256: string | null;
  poster_sha256: string | null;
  expires_at: number;
};

type LoginAttemptRow = {
  attempts: number;
  window_started: number;
  blocked_until: number;
};

type MediaChunkRow = {
  chunk_index: number;
  bytes: unknown;
  byte_length: number;
};

type PreparedMedia = {
  mime: string;
  size: number;
  bytes: ArrayBuffer;
  sha256: string;
};

type SessionClaims = {
  v: 1;
  iat: number;
  exp: number;
};

type LiveRole = "pending" | "broadcaster" | "viewer";

type LiveSocketAttachment = {
  peerId: string;
  role: LiveRole;
  joinedAt: number;
  sessionExpiresAt: number;
  rateWindowStartedAt: number;
  rateWindowMessages: number;
  relayRequested: boolean;
  relayAwaitingAck: boolean;
  relayAcknowledged: boolean;
  lastRelayFrameAt: number;
};

type LiveRoomSnapshot = {
  broadcaster: { socket: WebSocket; state: LiveSocketAttachment } | null;
  viewers: Array<{ socket: WebSocket; state: LiveSocketAttachment }>;
};

type TurnCredentialCache = {
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  expiresAt: number;
};

type TurnCredentialRateState = {
  windowStartedAt: number;
  attempts: number;
  lastFailureAt: number;
};

const SESSION_COOKIE = "__Host-safebot_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 99;
const MAX_CLEANUP_BATCHES = 8;
const MEDIA_CHUNK_BYTES = 1_000_000;
const MEDIA_READ_GROUP_CHUNKS = 4;
const MAX_ACTIVE_MEDIA_BYTES = 100_000_000;
const MAX_JSON_BODY_BYTES = 2 * 1024;
const MAX_META_BYTES = 8 * 1024;
const MAX_CLIP_BYTES = 12 * 1024 * 1024;
const MAX_POSTER_BYTES = 1024 * 1024;
const LIVE_ROOM_NAME = "safebot-main-room";
const LIVE_SESSION_EXPIRY_HEADER = "X-Safebot-Session-Expires-At";
const TURN_CREDENTIAL_TTL_SECONDS = 60 * 60;
const TURN_CREDENTIAL_EXPIRY_SAFETY_SECONDS = 30;
const TURN_CREDENTIAL_REFRESH_MARGIN_MS = 2 * 60 * 1000;
const TURN_CREDENTIAL_MIN_TTL_SECONDS = 60;
const TURN_PROVIDER_RATE_WINDOW_MS = 60 * 60 * 1000;
const TURN_PROVIDER_MAX_ATTEMPTS_PER_WINDOW = 3;
const TURN_PROVIDER_FAILURE_COOLDOWN_MS = 30 * 1000;
const TURN_CACHE_STORAGE_KEY = "turn-credential-cache";
const TURN_RATE_STORAGE_KEY = "turn-credential-rate";
const TURN_BROKER_PREFIX = "safebot-turn-broker";
const TURN_MAX_EXPIRES_AT_HEADER = "X-Safebot-Turn-Max-Expires-At";
const TURN_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const TURN_API_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const MAX_TURN_ICE_SERVERS = 4;
const MAX_TURN_URLS_PER_SERVER = 8;
const MAX_TURN_VALUE_LENGTH = 1024;
const MAX_TURN_RESPONSE_BYTES = 16 * 1024;
const TURN_UPSTREAM_TIMEOUT_MS = 5_000;
const MAX_LIVE_VIEWERS = 3;
const MAX_LIVE_CONNECTIONS = MAX_LIVE_VIEWERS + 1;
const MAX_SIGNAL_MESSAGE_BYTES = 64 * 1024;
const MAX_SDP_BYTES = 48 * 1024;
const MAX_ICE_CANDIDATE_BYTES = 4 * 1024;
const MAX_LIVE_MESSAGES_PER_MINUTE = 240;
const MAX_RELAY_FRAME_BYTES = 48 * 1024;
const MIN_RELAY_FRAME_INTERVAL_MS = 900;
const MAX_RELAY_FRAME_WIDTH = 320;
const MAX_RELAY_FRAME_HEIGHT = 640;
const MAX_RELAY_FRAME_PIXELS =
  MAX_RELAY_FRAME_WIDTH * MAX_RELAY_FRAME_HEIGHT;
const LIVE_JOIN_TIMEOUT_MS = 15_000;
const LIVE_PEER_ID_PATTERN = /^live-[0-9a-f-]{36}$/u;
const MAX_MULTIPART_BYTES =
  MAX_META_BYTES + MAX_CLIP_BYTES + MAX_POSTER_BYTES + 64 * 1024;
const ALLOWED_CLIP_TYPES = new Set(["video/mp4", "video/webm"]);
const ALLOWED_POSTER_TYPES = new Set(["image/jpeg", "image/webp"]);
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const EVENT_STATUSES = new Set<EventStatus>([
  "emergency",
  "recovered",
  "false_positive",
  "interrupted",
]);
const NOTIFICATION_STATUSES = new Set<NotificationStatus>([
  "sent",
  "not_sent",
  "permission_needed",
]);

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

function apiHeaders(extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function securePageResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: apiHeaders(extraHeaders),
  });
}

function errorResponse(error: ApiError) {
  const headers = new Headers();
  if (error.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(error.retryAfterSeconds));
  }
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
    },
    error.status,
    headers,
  );
}

function methodNotAllowed(allowed: string[]) {
  return jsonResponse(
    {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "지원하지 않는 요청 방식입니다.",
      },
    },
    405,
    { Allow: allowed.join(", ") },
  );
}

function normalizeMime(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

async function constantTimePasswordMatches(expected: string, provided: string) {
  const [expectedHash, providedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
  ]);
  return timingSafeEqual(
    new Uint8Array(expectedHash),
    new Uint8Array(providedHash),
  );
}

function getCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    const key = entry.slice(0, separator).trim();
    if (key === name) return entry.slice(separator + 1).trim();
  }
  return null;
}

async function createSessionCookie(secret: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    v: 1,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signedValue = `v1.${payload}`;
  const signature = bytesToBase64Url(await hmac(secret, signedValue));
  return `${SESSION_COOKIE}=${signedValue}.${signature}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function readSession(request: Request, secret: string) {
  const cookie = getCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;

  const payloadBytes = base64UrlToBytes(parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  if (!payloadBytes || !signature) return null;

  const expectedSignature = await hmac(secret, `v1.${parts[1]}`);
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  try {
    const claims = JSON.parse(
      new TextDecoder().decode(payloadBytes),
    ) as Partial<SessionClaims>;
    const now = Math.floor(Date.now() / 1000);
    if (
      claims.v !== 1 ||
      !Number.isInteger(claims.iat) ||
      !Number.isInteger(claims.exp) ||
      (claims.iat as number) > now + 60 ||
      (claims.exp as number) <= now ||
      (claims.exp as number) - (claims.iat as number) > SESSION_TTL_SECONDS
    ) {
      return null;
    }
    return claims as SessionClaims;
  } catch {
    return null;
  }
}

function authConfigurationIssue(env: Env) {
  if (!env.DB) return "관제 데이터베이스가 연결되지 않았습니다.";
  if (!env.CONTROL_PASSWORD || env.CONTROL_PASSWORD.length < 8) {
    return "CONTROL_PASSWORD 보안 비밀값을 8자 이상으로 설정해야 합니다.";
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    return "SESSION_SECRET 보안 비밀값을 32자 이상으로 설정해야 합니다.";
  }
  return null;
}

function assertSameOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (origin && origin !== url.origin) {
    throw new ApiError(
      403,
      "CROSS_ORIGIN_REQUEST",
      "다른 사이트에서 보낸 요청은 허용되지 않습니다.",
    );
  }
  if (fetchSite === "cross-site") {
    throw new ApiError(
      403,
      "CROSS_ORIGIN_REQUEST",
      "다른 사이트에서 보낸 요청은 허용되지 않습니다.",
    );
  }
}

async function requireSession(request: Request, env: Env) {
  const issue = authConfigurationIssue(env);
  if (issue || !env.SESSION_SECRET) {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", issue ?? "로그인 설정 오류");
  }
  const claims = await readSession(request, env.SESSION_SECRET);
  if (!claims) {
    throw new ApiError(
      401,
      "AUTH_REQUIRED",
      "관제센터 로그인이 필요합니다.",
    );
  }
  return claims;
}

async function loginIdentity(request: Request, secret: string) {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return bytesToBase64Url(await hmac(secret, `login-attempt:${address}`));
}

async function readLoginAttempt(db: D1Database, identity: string) {
  return db
    .prepare(
      `SELECT attempts, window_started, blocked_until
       FROM login_attempts
       WHERE identity = ?1`,
    )
    .bind(identity)
    .first<LoginAttemptRow>();
}

async function recordFailedLogin(
  db: D1Database,
  identity: string,
  now: number,
) {
  const windowCutoff = now - LOGIN_WINDOW_MS;
  await db
    .prepare(
      `INSERT INTO login_attempts (
         identity, attempts, window_started, blocked_until, updated_at
       ) VALUES (?1, 1, ?2, 0, ?2)
       ON CONFLICT(identity) DO UPDATE SET
         attempts = CASE
           WHEN login_attempts.window_started < ?3 THEN 1
           ELSE login_attempts.attempts + 1
         END,
         window_started = CASE
           WHEN login_attempts.window_started < ?3 THEN ?2
           ELSE login_attempts.window_started
         END,
         blocked_until = CASE
           WHEN (
             CASE
               WHEN login_attempts.window_started < ?3 THEN 1
               ELSE login_attempts.attempts + 1
             END
           ) >= ?4 THEN ?2 + ?5
           ELSE 0
         END,
         updated_at = ?2`,
    )
    .bind(identity, now, windowCutoff, LOGIN_MAX_ATTEMPTS, LOGIN_BLOCK_MS)
    .run();
  return readLoginAttempt(db, identity);
}

async function handleSessionStatus(request: Request, env: Env) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const issue = authConfigurationIssue(env);
  if (issue || !env.SESSION_SECRET) {
    return jsonResponse({ authenticated: false, configured: false });
  }
  const session = await readSession(request, env.SESSION_SECRET);
  return jsonResponse({
    authenticated: session !== null,
    configured: true,
    ...(session ? { expiresAt: new Date(session.exp * 1000).toISOString() } : {}),
  });
}

async function handleLogin(request: Request, env: Env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  assertSameOrigin(request);

  const issue = authConfigurationIssue(env);
  if (issue || !env.DB || !env.CONTROL_PASSWORD || !env.SESSION_SECRET) {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", issue ?? "로그인 설정 오류");
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new ApiError(
      413,
      "REQUEST_TOO_LARGE",
      "로그인 요청의 크기가 너무 큽니다.",
    );
  }

  const identity = await loginIdentity(request, env.SESSION_SECRET);
  const now = Date.now();
  let previousAttempt: LoginAttemptRow | null;
  try {
    previousAttempt = await readLoginAttempt(env.DB, identity);
  } catch {
    throw new ApiError(
      503,
      "DATABASE_NOT_READY",
      "로그인 데이터베이스 준비가 필요합니다.",
    );
  }

  if (previousAttempt && previousAttempt.blocked_until > now) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((previousAttempt.blocked_until - now) / 1000),
    );
    throw new ApiError(
      429,
      "TOO_MANY_ATTEMPTS",
      "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      retryAfterSeconds,
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (utf8Length(text) > MAX_JSON_BODY_BYTES) {
      throw new ApiError(
        413,
        "REQUEST_TOO_LARGE",
        "로그인 요청의 크기가 너무 큽니다.",
      );
    }
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      "INVALID_JSON",
      "올바른 로그인 정보를 입력해 주세요.",
    );
  }
  const password =
    body && typeof body === "object" && "password" in body
      ? (body as { password?: unknown }).password
      : undefined;
  if (typeof password !== "string" || password.length > 512) {
    throw new ApiError(
      400,
      "INVALID_PASSWORD",
      "올바른 관제 비밀번호를 입력해 주세요.",
    );
  }

  const matches = await constantTimePasswordMatches(
    env.CONTROL_PASSWORD,
    password,
  );
  if (!matches) {
    let attempt: LoginAttemptRow | null;
    try {
      attempt = await recordFailedLogin(env.DB, identity, now);
    } catch {
      throw new ApiError(
        503,
        "DATABASE_NOT_READY",
        "로그인 데이터베이스 준비가 필요합니다.",
      );
    }
    if (attempt && attempt.blocked_until > now) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((attempt.blocked_until - now) / 1000),
      );
      throw new ApiError(
        429,
        "TOO_MANY_ATTEMPTS",
        "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        retryAfterSeconds,
      );
    }
    throw new ApiError(
      401,
      "INVALID_CREDENTIALS",
      "관제 비밀번호가 올바르지 않습니다.",
    );
  }

  await env.DB
    .prepare("DELETE FROM login_attempts WHERE identity = ?1")
    .bind(identity)
    .run();
  const sessionCookie = await createSessionCookie(env.SESSION_SECRET);
  return jsonResponse(
    { ok: true, authenticated: true },
    200,
    { "Set-Cookie": sessionCookie },
  );
}

async function handleLogout(request: Request) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  assertSameOrigin(request);
  return jsonResponse(
    { ok: true },
    200,
    { "Set-Cookie": clearSessionCookie() },
  );
}

function requireFiniteNumber(
  value: unknown,
  name: string,
  min: number,
  max: number,
) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      `${name} 값이 올바르지 않습니다.`,
    );
  }
  return value;
}

function optionalCount(value: unknown, name: string) {
  if (value === undefined || value === null) return undefined;
  const count = requireFiniteNumber(value, name, 0, 10_000);
  if (!Number.isInteger(count)) {
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      `${name} 값이 올바르지 않습니다.`,
    );
  }
  return count;
}

function requireText(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
) {
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      `${name} 값이 올바르지 않습니다.`,
    );
  }
  const text = value.trim();
  if (
    text.length < minimum ||
    text.length > maximum ||
    utf8Length(text) > maximum * 4
  ) {
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      `${name} 길이가 올바르지 않습니다.`,
    );
  }
  return text;
}

function parseEventMeta(value: unknown): EventMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      "이벤트 정보가 올바르지 않습니다.",
    );
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.status !== "string" ||
    !EVENT_STATUSES.has(input.status as EventStatus)
  ) {
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      "이벤트 상태가 올바르지 않습니다.",
    );
  }
  if (
    typeof input.notification !== "string" ||
    !NOTIFICATION_STATUSES.has(input.notification as NotificationStatus)
  ) {
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      "알림 상태가 올바르지 않습니다.",
    );
  }

  const createdAtText = requireText(input.createdAt, "createdAt", 10, 40);
  const createdAt = Date.parse(createdAtText);
  const now = Date.now();
  if (
    !Number.isFinite(createdAt) ||
    createdAt > now + 5 * 60 * 1000 ||
    createdAt < now - 30 * 24 * 60 * 60 * 1000
  ) {
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      "이벤트 발생시각이 허용 범위를 벗어났습니다.",
    );
  }

  let id: string | undefined;
  if (input.id !== undefined) {
    if (typeof input.id !== "string" || !EVENT_ID_PATTERN.test(input.id)) {
      throw new ApiError(
        400,
        "INVALID_EVENT_META",
        "이벤트 ID가 올바르지 않습니다.",
      );
    }
    id = input.id;
  }

  let deviceId: string | undefined;
  if (input.deviceId !== undefined && input.deviceId !== null) {
    deviceId = requireText(input.deviceId, "deviceId", 1, 80);
  }

  return {
    ...(id ? { id } : {}),
    status: input.status as EventStatus,
    title: requireText(input.title, "title", 1, 120),
    detail: requireText(input.detail, "detail", 0, 500),
    createdAt: new Date(createdAt).toISOString(),
    durationSeconds: requireFiniteNumber(
      input.durationSeconds,
      "durationSeconds",
      0,
      30,
    ),
    confidence: requireFiniteNumber(input.confidence, "confidence", 0, 1),
    notification: input.notification as NotificationStatus,
    people: optionalCount(input.people, "people"),
    objects: optionalCount(input.objects, "objects"),
    ...(deviceId ? { deviceId } : {}),
  };
}

async function formMeta(form: FormData) {
  const entry = form.get("meta");
  let text: string;
  if (typeof entry === "string") {
    text = entry;
  } else if (entry instanceof Blob) {
    if (entry.size > MAX_META_BYTES) {
      throw new ApiError(
        413,
        "EVENT_META_TOO_LARGE",
        "이벤트 정보의 크기가 너무 큽니다.",
      );
    }
    text = await entry.text();
  } else {
    throw new ApiError(
      400,
      "MISSING_EVENT_META",
      "이벤트 정보가 누락되었습니다.",
    );
  }
  if (utf8Length(text) > MAX_META_BYTES) {
    throw new ApiError(
      413,
      "EVENT_META_TOO_LARGE",
      "이벤트 정보의 크기가 너무 큽니다.",
    );
  }
  try {
    return parseEventMeta(JSON.parse(text));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      "INVALID_EVENT_META",
      "이벤트 JSON을 확인해 주세요.",
    );
  }
}

function formBlob(form: FormData, name: "clip" | "poster") {
  const entry = form.get(name);
  if (entry === null) return null;
  if (!(entry instanceof Blob)) {
    throw new ApiError(
      400,
      "INVALID_MEDIA",
      `${name} 파일이 올바르지 않습니다.`,
    );
  }
  return entry;
}

function validateFormEnvelope(form: FormData) {
  const allowedNames = new Set(["meta", "clip", "poster"]);
  let totalBytes = 0;
  const counts = new Map<string, number>();
  for (const [name, value] of form.entries()) {
    if (!allowedNames.has(name)) {
      throw new ApiError(
        400,
        "UNEXPECTED_FORM_FIELD",
        "허용되지 않은 업로드 항목이 포함되어 있습니다.",
      );
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
    totalBytes +=
      typeof value === "string" ? utf8Length(value) : value.size;
    if (totalBytes > MAX_MULTIPART_BYTES) {
      throw new ApiError(
        413,
        "REQUEST_TOO_LARGE",
        "이벤트 업로드의 크기가 너무 큽니다.",
      );
    }
  }
  if (
    (counts.get("meta") ?? 0) !== 1 ||
    (counts.get("clip") ?? 0) > 1 ||
    (counts.get("poster") ?? 0) > 1
  ) {
    throw new ApiError(
      400,
      "DUPLICATE_FORM_FIELD",
      "이벤트 업로드 항목이 중복되었습니다.",
    );
  }
}

async function hasExpectedMagic(blob: Blob, mime: string) {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (mime === "video/mp4") {
    return (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
    );
  }
  if (mime === "video/webm") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  }
  if (mime === "image/jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  if (mime === "image/webp") {
    return (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  }
  return false;
}

async function validateMedia(
  blob: Blob | null,
  kind: "clip" | "poster",
) {
  if (!blob) return null;
  const maxBytes = kind === "clip" ? MAX_CLIP_BYTES : MAX_POSTER_BYTES;
  const allowed = kind === "clip" ? ALLOWED_CLIP_TYPES : ALLOWED_POSTER_TYPES;
  const mime = normalizeMime(blob.type);
  if (blob.size === 0 || blob.size > maxBytes) {
    throw new ApiError(
      blob.size > maxBytes ? 413 : 400,
      "INVALID_MEDIA_SIZE",
      kind === "clip"
        ? "영상은 12MB 이하만 저장할 수 있습니다."
        : "대표 이미지는 1MB 이하만 저장할 수 있습니다.",
    );
  }
  if (!allowed.has(mime)) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      kind === "clip"
        ? "MP4 또는 WebM 영상만 저장할 수 있습니다."
        : "JPEG 또는 WebP 이미지만 저장할 수 있습니다.",
    );
  }
  if (!(await hasExpectedMagic(blob, mime))) {
    throw new ApiError(
      415,
      "INVALID_MEDIA_CONTENT",
      "파일 내용과 형식이 일치하지 않습니다.",
    );
  }
  return { blob, mime, size: blob.size };
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function prepareMedia(
  media: { blob: Blob; mime: string; size: number } | null,
): Promise<PreparedMedia | null> {
  if (!media) return null;
  const bytes = await media.blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    mime: media.mime,
    size: media.size,
    bytes,
    sha256: bytesToHex(new Uint8Array(digest)),
  };
}

function extensionForMime(mime: string) {
  switch (mime) {
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "지원하지 않는 형식입니다.");
  }
}

function eventResponse(row: EventRow) {
  const clipUrl =
    row.clip_sha256 && row.clip_mime && row.clip_size
      ? `/api/events/${row.id}/clip`
      : null;
  const posterUrl =
    row.poster_sha256 && row.poster_mime && row.poster_size
      ? `/api/events/${row.id}/poster`
      : null;
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    detail: row.detail,
    createdAt: new Date(row.created_at).toISOString(),
    durationSeconds: row.duration_seconds,
    confidence: row.confidence,
    notification: row.notification,
    ...(row.people === null ? {} : { people: row.people }),
    ...(row.objects === null ? {} : { objects: row.objects }),
    ...(row.device_id === null ? {} : { deviceId: row.device_id }),
    expiresAt: new Date(row.expires_at).toISOString(),
    clipUrl,
    posterUrl,
    clipAvailable: clipUrl !== null,
    posterAvailable: posterUrl !== null,
    clipState: clipUrl ? "stored" : "none",
    mimeType: row.clip_mime ?? "",
    bytes: row.clip_size ?? 0,
  };
}

const EVENT_COLUMNS = `
  id, status, title, detail, created_at, duration_seconds, confidence,
  notification, people, objects, device_id, clip_mime, clip_size,
  poster_mime, poster_size, media_bytes, clip_sha256, poster_sha256,
  expires_at
`;

async function eventById(db: D1Database, id: string) {
  return db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM safety_events WHERE id = ?1`)
    .bind(id)
    .first<EventRow>();
}

function eventMatchesUpload(
  row: EventRow,
  meta: EventMeta,
  clip: PreparedMedia | null,
  poster: PreparedMedia | null,
) {
  return (
    row.status === meta.status &&
    row.title === meta.title &&
    row.detail === meta.detail &&
    row.created_at === Date.parse(meta.createdAt) &&
    row.duration_seconds === meta.durationSeconds &&
    row.confidence === meta.confidence &&
    row.notification === meta.notification &&
    row.people === (meta.people ?? null) &&
    row.objects === (meta.objects ?? null) &&
    row.device_id === (meta.deviceId ?? null) &&
    Boolean(row.clip_sha256) === Boolean(clip) &&
    row.clip_mime === (clip?.mime ?? null) &&
    row.clip_size === (clip?.size ?? null) &&
    row.clip_sha256 === (clip?.sha256 ?? null) &&
    Boolean(row.poster_sha256) === Boolean(poster) &&
    row.poster_mime === (poster?.mime ?? null) &&
    row.poster_size === (poster?.size ?? null) &&
    row.poster_sha256 === (poster?.sha256 ?? null) &&
    row.media_bytes === (clip?.size ?? 0) + (poster?.size ?? 0)
  );
}

async function listEvents(request: Request, env: Env) {
  if (!env.DB) {
    throw new ApiError(
      503,
      "DATABASE_NOT_CONFIGURED",
      "이벤트 데이터베이스가 연결되지 않았습니다.",
    );
  }
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(100, Math.max(1, requestedLimit))
    : 50;
  let result: D1Result<EventRow>;
  try {
    result = await env.DB
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM safety_events
         WHERE expires_at > ?1
         ORDER BY created_at DESC
         LIMIT ?2`,
      )
      .bind(Date.now(), limit)
      .all<EventRow>();
  } catch {
    throw new ApiError(
      503,
      "DATABASE_NOT_READY",
      "이벤트 데이터베이스 준비가 필요합니다.",
    );
  }
  return jsonResponse({ events: result.results.map(eventResponse) });
}

function mediaChunkStatements(
  db: D1Database,
  eventId: string,
  kind: "clip" | "poster",
  media: PreparedMedia | null,
) {
  if (!media) return [];
  const source = new Uint8Array(media.bytes);
  const statements: D1PreparedStatement[] = [];
  for (
    let offset = 0, chunkIndex = 0;
    offset < source.byteLength;
    offset += MEDIA_CHUNK_BYTES, chunkIndex += 1
  ) {
    const chunk = source.slice(
      offset,
      Math.min(source.byteLength, offset + MEDIA_CHUNK_BYTES),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO event_media_chunks (
             event_id, kind, chunk_index, bytes, byte_length
           )
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(eventId, kind, chunkIndex, chunk.buffer, chunk.byteLength),
    );
  }
  return statements;
}

function eventInsertStatement(
  db: D1Database,
  id: string,
  meta: EventMeta,
  clip: PreparedMedia | null,
  poster: PreparedMedia | null,
  expiresAt: number,
) {
  const mediaBytes = (clip?.size ?? 0) + (poster?.size ?? 0);
  return db
    .prepare(
      `INSERT INTO safety_events (
         id, status, title, detail, created_at, duration_seconds, confidence,
         notification, people, objects, device_id, clip_mime, clip_size,
         poster_mime, poster_size, expires_at,
         media_bytes, clip_sha256, poster_sha256
       )
       VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
         ?14, ?15, ?16, ?17, ?18, ?19
       )`,
    )
    .bind(
      id,
      meta.status,
      meta.title,
      meta.detail,
      Date.parse(meta.createdAt),
      meta.durationSeconds,
      meta.confidence,
      meta.notification,
      meta.people ?? null,
      meta.objects ?? null,
      meta.deviceId ?? null,
      clip?.mime ?? null,
      clip?.size ?? null,
      poster?.mime ?? null,
      poster?.size ?? null,
      expiresAt,
      mediaBytes,
      clip?.sha256 ?? null,
      poster?.sha256 ?? null,
    );
}

async function createEvent(request: Request, env: Env) {
  if (!env.DB) {
    throw new ApiError(
      503,
      "DATABASE_NOT_CONFIGURED",
      "이벤트 데이터베이스가 연결되지 않았습니다.",
    );
  }
  assertSameOrigin(request);

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ApiError(
      415,
      "UNSUPPORTED_CONTENT_TYPE",
      "multipart/form-data 형식으로 전송해 주세요.",
    );
  }
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_MULTIPART_BYTES
  ) {
    throw new ApiError(
      413,
      "REQUEST_TOO_LARGE",
      "이벤트 업로드의 크기가 너무 큽니다.",
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError(
      400,
      "INVALID_FORM_DATA",
      "이벤트 업로드 형식을 확인해 주세요.",
    );
  }
  validateFormEnvelope(form);
  const [meta, validatedClip, validatedPoster] = await Promise.all([
    formMeta(form),
    validateMedia(formBlob(form, "clip"), "clip"),
    validateMedia(formBlob(form, "poster"), "poster"),
  ]);
  if (
    (validatedClip?.size ?? 0) +
      (validatedPoster?.size ?? 0) +
      MAX_META_BYTES >
    MAX_MULTIPART_BYTES
  ) {
    throw new ApiError(
      413,
      "REQUEST_TOO_LARGE",
      "이벤트 업로드의 크기가 너무 큽니다.",
    );
  }
  const [clip, poster] = await Promise.all([
    prepareMedia(validatedClip),
    prepareMedia(validatedPoster),
  ]);

  const id = meta.id ?? crypto.randomUUID();
  const existing = await eventById(env.DB, id);
  if (existing) {
    if (eventMatchesUpload(existing, meta, clip, poster)) {
      return jsonResponse(
        { event: eventResponse(existing), idempotent: true },
        200,
      );
    }
    throw new ApiError(
      409,
      "EVENT_ALREADY_EXISTS",
      "같은 ID에 다른 내용의 이벤트가 이미 저장되어 있습니다.",
    );
  }

  const expiresAt = Date.now() + EVENT_RETENTION_MS;
  const mediaBytes = (clip?.size ?? 0) + (poster?.size ?? 0);
  const statements = [
    env.DB
      .prepare(
        `INSERT INTO media_usage (singleton, active_bytes, updated_at)
         VALUES (1, ?1, ?2)
         ON CONFLICT(singleton) DO UPDATE SET
           active_bytes = media_usage.active_bytes + excluded.active_bytes,
           updated_at = excluded.updated_at`,
      )
      .bind(mediaBytes, Date.now()),
    eventInsertStatement(env.DB, id, meta, clip, poster, expiresAt),
    ...mediaChunkStatements(env.DB, id, "clip", clip),
    ...mediaChunkStatements(env.DB, id, "poster", poster),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const concurrentWinner = await eventById(env.DB, id).catch(() => null);
    if (concurrentWinner) {
      if (eventMatchesUpload(concurrentWinner, meta, clip, poster)) {
        return jsonResponse(
          { event: eventResponse(concurrentWinner), idempotent: true },
          200,
        );
      }
      throw new ApiError(
        409,
        "EVENT_ALREADY_EXISTS",
        "같은 ID에 다른 내용의 이벤트가 이미 저장되어 있습니다.",
      );
    }
    if (String(error).includes("media_usage_active_bytes_limit")) {
      throw new ApiError(
        507,
        "MEDIA_STORAGE_LIMIT_REACHED",
        `서버 영상 보관 한도(${MAX_ACTIVE_MEDIA_BYTES / 1_000_000}MB)에 도달했습니다. 오래된 이력을 삭제한 뒤 다시 시도해 주세요.`,
      );
    }
    throw new ApiError(
      503,
      "EVENT_SAVE_FAILED",
      "이벤트를 안전하게 저장하지 못했습니다.",
    );
  }

  const saved = await eventById(env.DB, id);
  if (!saved) {
    throw new ApiError(
      503,
      "EVENT_SAVE_FAILED",
      "저장된 이벤트를 확인하지 못했습니다.",
    );
  }
  if (!eventMatchesUpload(saved, meta, clip, poster)) {
    throw new ApiError(
      409,
      "EVENT_ALREADY_EXISTS",
      "같은 ID에 다른 내용의 이벤트가 이미 저장되어 있습니다.",
    );
  }
  return jsonResponse({ event: eventResponse(saved) }, 201);
}

function parseRange(value: string, size: number) {
  if (!value.startsWith("bytes=") || value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(size, suffix);
    return { offset: size - length, length };
  }

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  const end = Math.min(size - 1, requestedEnd);
  return { offset: start, length: end - start + 1 };
}

function chunkBytes(value: unknown) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte))) {
    return Uint8Array.from(value as number[]);
  }
  throw new ApiError(
    503,
    "MEDIA_READ_FAILED",
    "저장 영상 조각을 읽지 못했습니다.",
  );
}

async function readMediaRange(
  db: D1Database,
  eventId: string,
  kind: "clip" | "poster",
  offset: number,
  length: number,
) {
  const firstChunk = Math.floor(offset / MEDIA_CHUNK_BYTES);
  const lastChunk = Math.floor((offset + length - 1) / MEDIA_CHUNK_BYTES);
  const rows: MediaChunkRow[] = [];
  try {
    for (
      let groupStart = firstChunk;
      groupStart <= lastChunk;
      groupStart += MEDIA_READ_GROUP_CHUNKS
    ) {
      const groupEnd = Math.min(
        lastChunk,
        groupStart + MEDIA_READ_GROUP_CHUNKS - 1,
      );
      const result = await db
        .prepare(
          `SELECT chunk_index, bytes, byte_length
           FROM event_media_chunks
           WHERE event_id = ?1
             AND kind = ?2
             AND chunk_index BETWEEN ?3 AND ?4
           ORDER BY chunk_index ASC`,
        )
        .bind(eventId, kind, groupStart, groupEnd)
        .all<MediaChunkRow>();
      rows.push(...result.results);
    }
  } catch {
    throw new ApiError(
      503,
      "MEDIA_READ_FAILED",
      "저장 영상을 불러오지 못했습니다.",
    );
  }

  if (rows.length !== lastChunk - firstChunk + 1) {
    throw new ApiError(
      503,
      "MEDIA_INCOMPLETE",
      "저장 영상 조각이 누락되었습니다.",
    );
  }

  const output = new Uint8Array(length);
  let written = 0;
  for (
    let expectedIndex = firstChunk;
    expectedIndex <= lastChunk;
    expectedIndex += 1
  ) {
    const row = rows[expectedIndex - firstChunk];
    const bytes = row ? chunkBytes(row.bytes) : null;
    if (
      !row ||
      row.chunk_index !== expectedIndex ||
      !bytes ||
      bytes.byteLength !== row.byte_length ||
      bytes.byteLength > MEDIA_CHUNK_BYTES
    ) {
      throw new ApiError(
        503,
        "MEDIA_INCOMPLETE",
        "저장 영상 조각이 손상되었습니다.",
      );
    }

    const chunkStart = expectedIndex * MEDIA_CHUNK_BYTES;
    const startInChunk = Math.max(0, offset - chunkStart);
    const endInChunk = Math.min(
      bytes.byteLength,
      offset + length - chunkStart,
    );
    if (endInChunk <= startInChunk) {
      throw new ApiError(
        503,
        "MEDIA_INCOMPLETE",
        "저장 영상 범위를 구성하지 못했습니다.",
      );
    }
    const piece = bytes.subarray(startInChunk, endInChunk);
    output.set(piece, written);
    written += piece.byteLength;
  }

  if (written !== length) {
    throw new ApiError(
      503,
      "MEDIA_INCOMPLETE",
      "저장 영상의 길이가 일치하지 않습니다.",
    );
  }
  return output;
}

async function serveEventMedia(
  request: Request,
  env: Env,
  id: string,
  kind: "clip" | "poster",
) {
  if (!EVENT_ID_PATTERN.test(id)) {
    throw new ApiError(404, "EVENT_NOT_FOUND", "이벤트를 찾을 수 없습니다.");
  }
  if (!env.DB) {
    throw new ApiError(
      503,
      "DATABASE_NOT_CONFIGURED",
      "이벤트 데이터베이스가 연결되지 않았습니다.",
    );
  }
  const event = await eventById(env.DB, id);
  if (!event || event.expires_at <= Date.now()) {
    throw new ApiError(404, "EVENT_NOT_FOUND", "이벤트를 찾을 수 없습니다.");
  }
  const mime = kind === "clip" ? event.clip_mime : event.poster_mime;
  const size = kind === "clip" ? event.clip_size : event.poster_size;
  const checksum =
    kind === "clip" ? event.clip_sha256 : event.poster_sha256;
  if (!mime || !size || !checksum) {
    throw new ApiError(
      404,
      "MEDIA_NOT_FOUND",
      kind === "clip"
        ? "저장된 10초 영상이 없습니다."
        : "저장된 대표 이미지가 없습니다.",
    );
  }

  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Type", mime);
  headers.set(
    "Content-Disposition",
    `inline; filename="${id}.${extensionForMime(mime)}"`,
  );
  headers.set("ETag", `"${checksum}"`);
  headers.set("Last-Modified", new Date(event.created_at).toUTCString());
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`,
    );
    headers.set("Content-Length", String(range.length));
    if (request.method === "HEAD") {
      return new Response(null, { status: 206, headers });
    }
    const bytes = await readMediaRange(
      env.DB,
      id,
      kind,
      range.offset,
      range.length,
    );
    return new Response(bytes, { status: 206, headers });
  }

  headers.set("Content-Length", String(size));
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  const bytes = await readMediaRange(env.DB, id, kind, 0, size);
  return new Response(bytes, { status: 200, headers });
}

async function deleteEvent(env: Env, id: string) {
  if (!EVENT_ID_PATTERN.test(id)) {
    throw new ApiError(404, "EVENT_NOT_FOUND", "이벤트를 찾을 수 없습니다.");
  }
  if (!env.DB) {
    throw new ApiError(
      503,
      "DATABASE_NOT_CONFIGURED",
      "이벤트 데이터베이스가 연결되지 않았습니다.",
    );
  }
  const event = await eventById(env.DB, id);
  if (!event) {
    throw new ApiError(404, "EVENT_NOT_FOUND", "이벤트를 찾을 수 없습니다.");
  }
  try {
    const [, deleteResult] = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE media_usage
           SET
             active_bytes = active_bytes - COALESCE((
               SELECT media_bytes
               FROM safety_events
               WHERE id = ?1
                 AND created_at = ?2
                 AND expires_at = ?3
                 AND clip_sha256 IS ?4
                 AND poster_sha256 IS ?5
             ), 0),
             updated_at = ?6
           WHERE singleton = 1`,
        )
        .bind(
          id,
          event.created_at,
          event.expires_at,
          event.clip_sha256,
          event.poster_sha256,
          Date.now(),
        ),
      env.DB
        .prepare(
          `DELETE FROM safety_events
           WHERE id = ?1
             AND created_at = ?2
             AND expires_at = ?3
             AND clip_sha256 IS ?4
             AND poster_sha256 IS ?5`,
        )
        .bind(
          id,
          event.created_at,
          event.expires_at,
          event.clip_sha256,
          event.poster_sha256,
        ),
    ]);
    if ((deleteResult.meta.changes ?? 0) === 0) {
      const current = await eventById(env.DB, id);
      if (current) {
        throw new ApiError(
          409,
          "EVENT_CHANGED",
          "이벤트가 변경되어 삭제하지 않았습니다. 이력을 새로고침해 주세요.",
        );
      }
      return jsonResponse({ ok: true, idempotent: true });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      "EVENT_DELETE_FAILED",
      "이벤트와 저장 영상을 삭제하지 못했습니다.",
    );
  }
  return jsonResponse({ ok: true });
}

async function cleanupExpiredEvents(env: Env) {
  const db = env.DB;
  if (!db) return;
  const now = Date.now();
  for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch += 1) {
    const [, deleteResult] = await db.batch([
      db
        .prepare(
          `UPDATE media_usage
           SET
             active_bytes = active_bytes - COALESCE((
               SELECT SUM(media_bytes)
               FROM safety_events
               WHERE id IN (
                 SELECT id
                 FROM safety_events
                 WHERE expires_at <= ?1
                 ORDER BY expires_at ASC, id ASC
                 LIMIT ?2
               )
             ), 0),
             updated_at = ?3
           WHERE singleton = 1`,
        )
        .bind(now, CLEANUP_BATCH_SIZE, Date.now()),
      db
        .prepare(
          `DELETE FROM safety_events
           WHERE id IN (
             SELECT id
             FROM safety_events
             WHERE expires_at <= ?1
             ORDER BY expires_at ASC, id ASC
             LIMIT ?2
           )`,
        )
        .bind(now, CLEANUP_BATCH_SIZE),
    ]);
    const deleted = deleteResult.meta.changes ?? 0;
    if (deleted === 0 || deleted < CLEANUP_BATCH_SIZE) break;
  }
  await db
    .prepare("DELETE FROM login_attempts WHERE updated_at < ?1")
    .bind(now - 24 * 60 * 60 * 1000)
    .run();
}

async function handleEventsCollection(request: Request, env: Env) {
  await requireSession(request, env);
  if (request.method === "GET") return listEvents(request, env);
  if (request.method === "POST") return createEvent(request, env);
  return methodNotAllowed(["GET", "POST"]);
}

async function handleEventResource(
  request: Request,
  env: Env,
  id: string,
  resource?: "clip" | "poster",
) {
  await requireSession(request, env);
  if (resource) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    return serveEventMedia(request, env, id, resource);
  }
  if (request.method === "DELETE") {
    assertSameOrigin(request);
    return deleteEvent(env, id);
  }
  return methodNotAllowed(["DELETE"]);
}

function assertLiveSocketOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "CROSS_ORIGIN_REQUEST",
      "동일한 SAFEBOT 사이트에서만 실시간 연결할 수 있습니다.",
    );
  }
  assertSameOrigin(request);
}

function allowedCloudflareIceUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TURN_VALUE_LENGTH
  ) {
    return false;
  }
  return (
    /^stun:stun\.cloudflare\.com:3478$/u.test(value) ||
    /^turns?:turn\.cloudflare\.com:(?:3478|80|443|5349)(?:\?transport=(?:udp|tcp))?$/u.test(
      value,
    )
  );
}

function sanitizeCloudflareIceServer(value: unknown) {
  if (!isRecord(value)) return null;
  const rawUrls = Array.isArray(value.urls) ? value.urls : [value.urls];
  const urls = rawUrls
    .slice(0, MAX_TURN_URLS_PER_SERVER)
    .filter(allowedCloudflareIceUrl);
  if (urls.length === 0) return null;

  const hasTurnUrl = urls.some((url) => url.startsWith("turn"));
  if (!hasTurnUrl) {
    return { urls: urls.length === 1 ? urls[0] : urls };
  }
  if (
    typeof value.username !== "string" ||
    value.username.length === 0 ||
    value.username.length > MAX_TURN_VALUE_LENGTH ||
    typeof value.credential !== "string" ||
    value.credential.length === 0 ||
    value.credential.length > MAX_TURN_VALUE_LENGTH
  ) {
    return null;
  }
  return {
    urls: urls.length === 1 ? urls[0] : urls,
    username: value.username,
    credential: value.credential,
  };
}

function sanitizeCloudflareIceServers(value: unknown) {
  if (!Array.isArray(value)) return null;
  const iceServers = value
    .slice(0, MAX_TURN_ICE_SERVERS)
    .map(sanitizeCloudflareIceServer)
    .filter((server) => server !== null);
  const hasTurnServer = iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => url.startsWith("turn"));
  });
  return hasTurnServer ? iceServers : null;
}

function turnCredentialResponse(cache: TurnCredentialCache) {
  const expiresInSeconds = Math.max(
    0,
    Math.floor((cache.expiresAt - Date.now()) / 1000),
  );
  return jsonResponse({
    iceServers: cache.iceServers,
    expiresAt: cache.expiresAt,
    expiresInSeconds,
    profile: {
      width: 480,
      height: 360,
      frameRate: 12,
      maxVideoBitrate: 350_000,
      audio: false,
      maxViewers: MAX_LIVE_VIEWERS,
    },
  });
}

async function turnCredentialBrokerName(request: Request, secret: string) {
  const cookie = getCookie(request, SESSION_COOKIE) ?? "";
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return `${TURN_BROKER_PREFIX}-${bytesToBase64Url(
    await hmac(secret, `${cookie}:${address}`),
  )}`;
}

async function handleLiveIceServers(request: Request, env: Env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "CROSS_ORIGIN_REQUEST",
      "동일한 SAFEBOT 사이트에서만 원격 영상 중계를 요청할 수 있습니다.",
    );
  }
  assertSameOrigin(request);
  const claims = await requireSession(request, env);
  if (!env.LIVE_ROOM || !env.SESSION_SECRET) {
    throw new ApiError(
      503,
      "TURN_NOT_CONFIGURED",
      "원격 영상 중계가 아직 준비되지 않았습니다.",
    );
  }
  const maxExpiresAt = Math.min(
    claims.exp * 1000,
    Date.now() + TURN_CREDENTIAL_TTL_SECONDS * 1000,
  );
  if (
    maxExpiresAt - Date.now() <
    (TURN_CREDENTIAL_MIN_TTL_SECONDS +
      TURN_CREDENTIAL_EXPIRY_SAFETY_SECONDS) *
      1000
  ) {
    throw new ApiError(
      401,
      "SESSION_EXPIRING",
      "관제 인증이 곧 만료됩니다. 다시 로그인해 주세요.",
    );
  }
  const brokerName = await turnCredentialBrokerName(
    request,
    env.SESSION_SECRET,
  );
  const brokerId = env.LIVE_ROOM.idFromName(brokerName);
  return env.LIVE_ROOM.get(brokerId).fetch(
    new Request("https://safebot.internal/internal/turn-credentials", {
      method: "POST",
      headers: {
        [TURN_MAX_EXPIRES_AT_HEADER]: String(maxExpiresAt),
      },
    }),
  );
}

async function handleLiveSocket(request: Request, env: Env) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  assertLiveSocketOrigin(request);
  const claims = await requireSession(request, env);

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError(
      426,
      "WEBSOCKET_UPGRADE_REQUIRED",
      "WebSocket 연결 요청이 필요합니다.",
    );
  }
  if (!env.LIVE_ROOM) {
    throw new ApiError(
      503,
      "LIVE_ROOM_NOT_CONFIGURED",
      "실시간 관제 연결이 아직 준비되지 않았습니다.",
    );
  }

  const roomId = env.LIVE_ROOM.idFromName(LIVE_ROOM_NAME);
  const headers = new Headers(request.headers);
  headers.set(LIVE_SESSION_EXPIRY_HEADER, String(claims.exp * 1000));
  headers.delete("Cookie");
  return env.LIVE_ROOM
    .get(roomId)
    .fetch(new Request(request, { headers }));
}

async function handleApi(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/auth/session") {
      return await handleSessionStatus(request, env);
    }
    if (url.pathname === "/api/auth/login") {
      return await handleLogin(request, env);
    }
    if (url.pathname === "/api/auth/logout") {
      return await handleLogout(request);
    }
    if (url.pathname === "/api/live/ice-servers") {
      return await handleLiveIceServers(request, env);
    }
    if (url.pathname === "/api/live/socket") {
      return await handleLiveSocket(request, env);
    }
    if (url.pathname === "/api/events") {
      ctx.waitUntil(cleanupExpiredEvents(env).catch(() => undefined));
      return await handleEventsCollection(request, env);
    }
    const eventRoute =
      /^\/api\/events\/([A-Za-z0-9_-]+)(?:\/(clip|poster))?$/u.exec(
        url.pathname,
      );
    if (eventRoute) {
      ctx.waitUntil(cleanupExpiredEvents(env).catch(() => undefined));
      return await handleEventResource(
        request,
        env,
        eventRoute[1],
        eventRoute[2] as "clip" | "poster" | undefined,
      );
    }
    throw new ApiError(404, "API_NOT_FOUND", "API 경로를 찾을 수 없습니다.");
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    console.error("SAFEBOT API error", error);
    return errorResponse(
      new ApiError(
        500,
        "INTERNAL_ERROR",
        "요청을 처리하는 중 오류가 발생했습니다.",
      ),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function readLiveAttachment(socket: WebSocket) {
  let value: unknown;
  try {
    value = socket.deserializeAttachment();
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.peerId !== "string" ||
    !LIVE_PEER_ID_PATTERN.test(value.peerId) ||
    (value.role !== "pending" &&
      value.role !== "broadcaster" &&
      value.role !== "viewer") ||
    typeof value.joinedAt !== "number" ||
    !Number.isFinite(value.joinedAt) ||
    typeof value.sessionExpiresAt !== "number" ||
    !Number.isInteger(value.sessionExpiresAt) ||
    value.sessionExpiresAt <= 0 ||
    typeof value.rateWindowStartedAt !== "number" ||
    !Number.isFinite(value.rateWindowStartedAt) ||
    typeof value.rateWindowMessages !== "number" ||
    !Number.isInteger(value.rateWindowMessages) ||
    typeof value.relayRequested !== "boolean" ||
    typeof value.relayAwaitingAck !== "boolean" ||
    typeof value.relayAcknowledged !== "boolean" ||
    typeof value.lastRelayFrameAt !== "number" ||
    !Number.isFinite(value.lastRelayFrameAt) ||
    value.lastRelayFrameAt < 0
  ) {
    return null;
  }
  return value as LiveSocketAttachment;
}

function sendLiveMessage(socket: WebSocket, value: unknown) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(value));
  } catch {
    // A peer can disconnect between readyState inspection and send().
  }
}

function sendLiveBinary(socket: WebSocket, value: ArrayBuffer) {
  if (socket.readyState !== 1) return false;
  try {
    socket.send(value);
    return true;
  } catch {
    // A peer can disconnect between readyState inspection and send().
    return false;
  }
}

function readRelayJpegDimensions(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;

    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 1 >= bytes.length) return null;

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (
      segmentLength < 2 ||
      offset + segmentLength > bytes.length
    ) {
      return null;
    }

    // Canvas JPEG output has no EXIF. Reject APP1 so a compromised sender
    // cannot smuggle metadata or an embedded thumbnail through the fallback.
    if (marker === 0xe1) return null;

    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      if (
        dimensions ||
        segmentLength < 8 ||
        bytes[offset + 2] !== 8
      ) {
        return null;
      }
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const components = bytes[offset + 7];
      if (
        width <= 0 ||
        height <= 0 ||
        components !== 3 ||
        segmentLength !== 8 + components * 3
      ) {
        return null;
      }
      dimensions = { width, height };
    }
    offset += segmentLength;
  }
  return dimensions;
}

function closeLiveSocket(
  socket: WebSocket,
  code: number,
  errorCode: string,
  message: string,
) {
  sendLiveMessage(socket, {
    type: "status",
    status: "error",
    code: errorCode,
    message,
  });
  try {
    socket.close(code, errorCode.slice(0, 120));
  } catch {
    // The connection may already be closing.
  }
}

function sendLiveError(
  socket: WebSocket,
  code: string,
  message: string,
  peerId?: string,
) {
  sendLiveMessage(socket, {
    type: "error",
    code,
    message,
    ...(peerId ? { peerId } : {}),
  });
}

function liveRoomSnapshot(
  state: DurableObjectState,
  excludedSocket?: WebSocket,
): LiveRoomSnapshot {
  let broadcaster: LiveRoomSnapshot["broadcaster"] = null;
  const viewers: LiveRoomSnapshot["viewers"] = [];
  for (const socket of state.getWebSockets()) {
    if (socket === excludedSocket || socket.readyState !== 1) continue;
    const attachment = readLiveAttachment(socket);
    if (!attachment) continue;
    if (attachment.role === "broadcaster" && !broadcaster) {
      broadcaster = { socket, state: attachment };
    } else if (attachment.role === "viewer") {
      viewers.push({ socket, state: attachment });
    }
  }
  return { broadcaster, viewers };
}

function liveRoomStatus(snapshot: LiveRoomSnapshot) {
  return {
    type: "status",
    status: "room-state",
    broadcasterOnline: snapshot.broadcaster !== null,
    viewerCount: snapshot.viewers.length,
    maxViewers: MAX_LIVE_VIEWERS,
  };
}

function broadcastLiveRoomStatus(
  state: DurableObjectState,
  excludedSocket?: WebSocket,
) {
  const snapshot = liveRoomSnapshot(state, excludedSocket);
  const message = liveRoomStatus(snapshot);
  if (snapshot.broadcaster) {
    sendLiveMessage(snapshot.broadcaster.socket, message);
  }
  for (const viewer of snapshot.viewers) {
    sendLiveMessage(viewer.socket, message);
  }
}

function requireSignalText(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty = false,
) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    utf8Length(value) > maximumBytes
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function requireSignalTarget(value: unknown) {
  if (typeof value !== "string" || !LIVE_PEER_ID_PATTERN.test(value)) {
    throw new Error("invalid target");
  }
  return value;
}

function parseSessionDescription(
  value: unknown,
  expectedType: "offer" | "answer",
) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "sdp"]) ||
    value.type !== expectedType
  ) {
    throw new Error("invalid session description");
  }
  return {
    type: expectedType,
    sdp: requireSignalText(value.sdp, "sdp", MAX_SDP_BYTES),
  };
}

function parseIceCandidate(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["candidate"], [
      "sdpMid",
      "sdpMLineIndex",
      "usernameFragment",
    ])
  ) {
    throw new Error("invalid ICE candidate");
  }
  const candidate = requireSignalText(
    value.candidate,
    "candidate",
    MAX_ICE_CANDIDATE_BYTES,
    true,
  );
  const sdpMid =
    value.sdpMid === undefined || value.sdpMid === null
      ? null
      : requireSignalText(value.sdpMid, "sdpMid", 128, true);
  const sdpMLineIndex =
    value.sdpMLineIndex === undefined || value.sdpMLineIndex === null
      ? null
      : value.sdpMLineIndex;
  if (
    sdpMLineIndex !== null &&
    (!Number.isInteger(sdpMLineIndex) ||
      (sdpMLineIndex as number) < 0 ||
      (sdpMLineIndex as number) > 65_535)
  ) {
    throw new Error("invalid sdpMLineIndex");
  }
  const usernameFragment =
    value.usernameFragment === undefined || value.usernameFragment === null
      ? null
      : requireSignalText(
          value.usernameFragment,
          "usernameFragment",
          256,
          true,
        );
  return {
    candidate,
    sdpMid,
    sdpMLineIndex: sdpMLineIndex as number | null,
    usernameFragment,
  };
}

function parseLiveSignal(message: string) {
  if (utf8Length(message) > MAX_SIGNAL_MESSAGE_BYTES) {
    throw new ApiError(
      1009,
      "SIGNAL_TOO_LARGE",
      "실시간 연결 메시지가 너무 큽니다.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new ApiError(
      1008,
      "INVALID_SIGNAL_JSON",
      "실시간 연결 메시지 형식이 올바르지 않습니다.",
    );
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ApiError(
      1008,
      "INVALID_SIGNAL",
      "실시간 연결 메시지가 올바르지 않습니다.",
    );
  }

  try {
    if (value.type === "join") {
      if (
        !hasExactKeys(value, ["type", "role"]) ||
        (value.role !== "broadcaster" && value.role !== "viewer")
      ) {
        throw new Error("invalid join");
      }
      return {
        type: "join" as const,
        role: value.role as "broadcaster" | "viewer",
      };
    }
    if (value.type === "offer" || value.type === "answer") {
      if (!hasExactKeys(value, ["type", "target", "sdp"])) {
        throw new Error("invalid description relay");
      }
      return {
        type: value.type,
        target: requireSignalTarget(value.target),
        sdp: parseSessionDescription(value.sdp, value.type),
      } as const;
    }
    if (value.type === "ice") {
      if (!hasExactKeys(value, ["type", "target", "candidate"])) {
        throw new Error("invalid ICE relay");
      }
      return {
        type: "ice" as const,
        target: requireSignalTarget(value.target),
        candidate: parseIceCandidate(value.candidate),
      };
    }
    if (value.type === "status") {
      if (
        !hasExactKeys(value, ["type", "state"]) ||
        (value.state !== "ready" &&
          value.state !== "live" &&
          value.state !== "paused" &&
          value.state !== "ended")
      ) {
        throw new Error("invalid status");
      }
      return { type: "status" as const, state: value.state };
    }
    if (
      value.type === "relay-request" ||
      value.type === "relay-stop" ||
      value.type === "relay-ack"
    ) {
      if (!hasExactKeys(value, ["type"])) {
        throw new Error("invalid relay control");
      }
      return {
        type: value.type as
          | "relay-request"
          | "relay-stop"
          | "relay-ack",
      };
    }
  } catch {
    throw new ApiError(
      1008,
      "INVALID_SIGNAL",
      "실시간 연결 메시지가 올바르지 않습니다.",
    );
  }

  throw new ApiError(
    1008,
    "UNKNOWN_SIGNAL_TYPE",
    "지원하지 않는 실시간 연결 메시지입니다.",
  );
}

function findLivePeer(
  snapshot: LiveRoomSnapshot,
  peerId: string,
  role: Exclude<LiveRole, "pending">,
) {
  if (
    role === "broadcaster" &&
    snapshot.broadcaster?.state.peerId === peerId
  ) {
    return snapshot.broadcaster;
  }
  if (role === "viewer") {
    return (
      snapshot.viewers.find((viewer) => viewer.state.peerId === peerId) ?? null
    );
  }
  return null;
}

/**
 * A single hibernatable signaling room. It relays WebRTC negotiation metadata
 * and short-lived fallback JPEG frames; neither is written to storage.
 */
export class LiveRoom {
  private turnCredentialsInFlight: Promise<TurnCredentialCache> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/internal/turn-credentials") {
      return this.handleTurnCredentialRequest(request);
    }
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return jsonResponse(
        {
          error: {
            code: "WEBSOCKET_UPGRADE_REQUIRED",
            message: "WebSocket 연결 요청이 필요합니다.",
          },
        },
        426,
      );
    }

    const now = Date.now();
    const sessionExpiresAt = Number(
      request.headers.get(LIVE_SESSION_EXPIRY_HEADER),
    );
    if (
      !Number.isInteger(sessionExpiresAt) ||
      sessionExpiresAt <= now
    ) {
      return jsonResponse(
        {
          error: {
            code: "SESSION_EXPIRED",
            message: "관제 인증이 만료되었습니다.",
          },
        },
        401,
      );
    }
    for (const socket of this.state.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const attachment = readLiveAttachment(socket);
      if (
        attachment?.role === "pending" &&
        now - attachment.joinedAt > LIVE_JOIN_TIMEOUT_MS
      ) {
        closeLiveSocket(
          socket,
          1008,
          "JOIN_TIMEOUT",
          "실시간 관제실 참여 시간이 초과되었습니다.",
        );
      }
    }
    const openConnections = this.state
      .getWebSockets()
      .filter((socket) => socket.readyState === 1).length;
    if (openConnections >= MAX_LIVE_CONNECTIONS) {
      return jsonResponse(
        {
          error: {
            code: "LIVE_ROOM_CONNECTION_LIMIT",
            message: "실시간 관제 연결 인원이 가득 찼습니다.",
          },
        },
        429,
        { "Retry-After": "5" },
      );
    }

    const [client, server] = Object.values(new WebSocketPair());
    const attachment: LiveSocketAttachment = {
      peerId: `live-${crypto.randomUUID()}`,
      role: "pending",
      joinedAt: now,
      sessionExpiresAt,
      rateWindowStartedAt: now,
      rateWindowMessages: 0,
      relayRequested: false,
      relayAwaitingAck: false,
      relayAcknowledged: false,
      lastRelayFrameAt: 0,
    };
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server);
    await this.scheduleNextSessionAlarm();

    const snapshot = liveRoomSnapshot(this.state);
    sendLiveMessage(server, {
      type: "status",
      status: "connected",
      peerId: attachment.peerId,
      broadcasterOnline: snapshot.broadcaster !== null,
      viewerCount: snapshot.viewers.length,
      maxViewers: MAX_LIVE_VIEWERS,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleTurnCredentialRequest(request: Request) {
    try {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      const maxExpiresAt = Number(
        request.headers.get(TURN_MAX_EXPIRES_AT_HEADER),
      );
      const now = Date.now();
      if (
        !Number.isInteger(maxExpiresAt) ||
        maxExpiresAt - now <
          (TURN_CREDENTIAL_MIN_TTL_SECONDS +
            TURN_CREDENTIAL_EXPIRY_SAFETY_SECONDS) *
            1000 ||
        maxExpiresAt > now + TURN_CREDENTIAL_TTL_SECONDS * 1000 + 5_000
      ) {
        throw new ApiError(
          401,
          "SESSION_EXPIRING",
          "관제 인증이 곧 만료됩니다. 다시 로그인해 주세요.",
        );
      }

      const cached =
        await this.state.storage.get<TurnCredentialCache>(
          TURN_CACHE_STORAGE_KEY,
        );
      if (
        cached &&
        Number.isInteger(cached.expiresAt) &&
        cached.expiresAt <= maxExpiresAt &&
        cached.expiresAt - now > TURN_CREDENTIAL_REFRESH_MARGIN_MS &&
        sanitizeCloudflareIceServers(cached.iceServers)
      ) {
        return turnCredentialResponse(cached);
      }

      if (!this.turnCredentialsInFlight) {
        this.turnCredentialsInFlight = this.issueTurnCredentials(
          maxExpiresAt,
        ).finally(() => {
          this.turnCredentialsInFlight = null;
        });
      }
      const issued = await this.turnCredentialsInFlight;
      if (issued.expiresAt > maxExpiresAt) {
        throw new ApiError(
          401,
          "SESSION_EXPIRING",
          "관제 인증이 곧 만료됩니다. 다시 로그인해 주세요.",
        );
      }
      return turnCredentialResponse(issued);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      return errorResponse(
        new ApiError(
          502,
          "TURN_CREDENTIALS_UNAVAILABLE",
          "원격 영상 중계 자격증명을 발급하지 못했습니다.",
        ),
      );
    }
  }

  private async issueTurnCredentials(
    maxExpiresAt: number,
  ): Promise<TurnCredentialCache> {
    const turnKeyId = this.env.TURN_KEY_ID?.trim() ?? "";
    const turnApiToken = this.env.TURN_KEY_API_TOKEN?.trim() ?? "";
    if (
      !TURN_KEY_ID_PATTERN.test(turnKeyId) ||
      !TURN_API_TOKEN_PATTERN.test(turnApiToken)
    ) {
      throw new ApiError(
        503,
        "TURN_NOT_CONFIGURED",
        "원격 영상 중계가 아직 준비되지 않았습니다.",
      );
    }

    const now = Date.now();
    const ttlSeconds = Math.min(
      TURN_CREDENTIAL_TTL_SECONDS,
      Math.floor((maxExpiresAt - now) / 1000) -
        TURN_CREDENTIAL_EXPIRY_SAFETY_SECONDS,
    );
    if (ttlSeconds < TURN_CREDENTIAL_MIN_TTL_SECONDS) {
      throw new ApiError(
        401,
        "SESSION_EXPIRING",
        "관제 인증이 곧 만료됩니다. 다시 로그인해 주세요.",
      );
    }

    const storedRate =
      await this.state.storage.get<TurnCredentialRateState>(
        TURN_RATE_STORAGE_KEY,
      );
    const rate: TurnCredentialRateState =
      storedRate &&
      Number.isInteger(storedRate.windowStartedAt) &&
      Number.isInteger(storedRate.attempts) &&
      Number.isInteger(storedRate.lastFailureAt) &&
      now - storedRate.windowStartedAt < TURN_PROVIDER_RATE_WINDOW_MS
        ? storedRate
        : {
            windowStartedAt: now,
            attempts: 0,
            lastFailureAt: 0,
          };
    if (
      rate.lastFailureAt > 0 &&
      now - rate.lastFailureAt < TURN_PROVIDER_FAILURE_COOLDOWN_MS
    ) {
      const retryAfter = Math.ceil(
        (TURN_PROVIDER_FAILURE_COOLDOWN_MS -
          (now - rate.lastFailureAt)) /
          1000,
      );
      throw new ApiError(
        503,
        "TURN_CREDENTIALS_COOLDOWN",
        "원격 영상 중계를 잠시 후 다시 시도해 주세요.",
        retryAfter,
      );
    }
    if (rate.attempts >= TURN_PROVIDER_MAX_ATTEMPTS_PER_WINDOW) {
      const retryAfter = Math.max(
        1,
        Math.ceil(
          (TURN_PROVIDER_RATE_WINDOW_MS -
            (now - rate.windowStartedAt)) /
            1000,
        ),
      );
      throw new ApiError(
        429,
        "TURN_CREDENTIALS_RATE_LIMIT",
        "원격 영상 중계 발급 한도에 도달했습니다.",
        retryAfter,
      );
    }
    rate.attempts += 1;
    await this.state.storage.put(TURN_RATE_STORAGE_KEY, rate);

    let upstream: Response;
    try {
      upstream = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${turnApiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: ttlSeconds }),
          redirect: "error",
          signal: AbortSignal.timeout(TURN_UPSTREAM_TIMEOUT_MS),
        },
      );
    } catch {
      rate.lastFailureAt = Date.now();
      await this.state.storage.put(TURN_RATE_STORAGE_KEY, rate);
      throw new ApiError(
        502,
        "TURN_CREDENTIALS_UNAVAILABLE",
        "원격 영상 중계 서버에 연결하지 못했습니다.",
      );
    }
    if (!upstream.ok) {
      rate.lastFailureAt = Date.now();
      await this.state.storage.put(TURN_RATE_STORAGE_KEY, rate);
      throw new ApiError(
        502,
        "TURN_CREDENTIALS_UNAVAILABLE",
        "원격 영상 중계 자격증명을 발급하지 못했습니다.",
      );
    }

    const contentLength = Number(upstream.headers.get("Content-Length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_TURN_RESPONSE_BYTES
    ) {
      rate.lastFailureAt = Date.now();
      await this.state.storage.put(TURN_RATE_STORAGE_KEY, rate);
      throw new ApiError(
        502,
        "TURN_CREDENTIALS_UNAVAILABLE",
        "원격 영상 중계 응답이 허용 크기를 초과했습니다.",
      );
    }

    let payload: unknown;
    try {
      const text = await upstream.text();
      if (utf8Length(text) > MAX_TURN_RESPONSE_BYTES) {
        throw new Error("TURN response too large");
      }
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const iceServers = isRecord(payload)
      ? sanitizeCloudflareIceServers(payload.iceServers)
      : null;
    if (!iceServers) {
      rate.lastFailureAt = Date.now();
      await this.state.storage.put(TURN_RATE_STORAGE_KEY, rate);
      throw new ApiError(
        502,
        "TURN_CREDENTIALS_UNAVAILABLE",
        "원격 영상 중계 응답 형식이 올바르지 않습니다.",
      );
    }

    rate.lastFailureAt = 0;
    const cache: TurnCredentialCache = {
      iceServers,
      expiresAt: now + ttlSeconds * 1000,
    };
    await this.state.storage.put({
      [TURN_CACHE_STORAGE_KEY]: cache,
      [TURN_RATE_STORAGE_KEY]: rate,
    });
    return cache;
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const attachment = readLiveAttachment(socket);
    if (!attachment) {
      closeLiveSocket(
        socket,
        1008,
        "INVALID_CONNECTION_STATE",
        "실시간 연결 상태가 올바르지 않습니다.",
      );
      return;
    }
    if (attachment.sessionExpiresAt <= Date.now()) {
      closeLiveSocket(
        socket,
        4401,
        "SESSION_EXPIRED",
        "관제 인증이 만료되었습니다.",
      );
      await this.scheduleNextSessionAlarm(socket);
      return;
    }
    const now = Date.now();
    if (now - attachment.rateWindowStartedAt >= 60_000) {
      attachment.rateWindowStartedAt = now;
      attachment.rateWindowMessages = 0;
    }
    attachment.rateWindowMessages += 1;
    socket.serializeAttachment(attachment);
    if (attachment.rateWindowMessages > MAX_LIVE_MESSAGES_PER_MINUTE) {
      closeLiveSocket(
        socket,
        1008,
        "SIGNAL_RATE_LIMIT",
        "실시간 연결 메시지가 너무 많습니다.",
      );
      return;
    }

    if (typeof message !== "string") {
      if (attachment.role === "pending") {
        closeLiveSocket(
          socket,
          1008,
          "JOIN_REQUIRED",
          "먼저 실시간 관제실 참여 메시지를 보내야 합니다.",
        );
        return;
      }
      if (attachment.role !== "broadcaster") {
        closeLiveSocket(
          socket,
          1008,
          "ROLE_NOT_ALLOWED",
          "현장 송출자만 대체 영상 프레임을 보낼 수 있습니다.",
        );
        return;
      }
      if (message.byteLength > MAX_RELAY_FRAME_BYTES) {
        closeLiveSocket(
          socket,
          1009,
          "RELAY_FRAME_TOO_LARGE",
          "대체 영상 프레임이 너무 큽니다.",
        );
        return;
      }
      const frameHeader = new Uint8Array(
        message,
        0,
        Math.min(3, message.byteLength),
      );
      const frameTrailer =
        message.byteLength >= 2
          ? new Uint8Array(message, message.byteLength - 2, 2)
          : new Uint8Array();
      if (
        frameHeader.length < 3 ||
        frameHeader[0] !== 0xff ||
        frameHeader[1] !== 0xd8 ||
        frameHeader[2] !== 0xff ||
        frameTrailer[0] !== 0xff ||
        frameTrailer[1] !== 0xd9
      ) {
        closeLiveSocket(
          socket,
          1008,
          "INVALID_RELAY_FRAME",
          "대체 영상 프레임은 JPEG 형식이어야 합니다.",
        );
        return;
      }
      const dimensions = readRelayJpegDimensions(message);
      if (
        !dimensions ||
        dimensions.width > MAX_RELAY_FRAME_WIDTH ||
        dimensions.height > MAX_RELAY_FRAME_HEIGHT ||
        dimensions.width * dimensions.height > MAX_RELAY_FRAME_PIXELS
      ) {
        closeLiveSocket(
          socket,
          1008,
          "INVALID_RELAY_DIMENSIONS",
          "대체 영상 프레임 해상도가 허용 범위를 벗어났습니다.",
        );
        return;
      }
      if (
        attachment.lastRelayFrameAt > 0 &&
        now - attachment.lastRelayFrameAt < MIN_RELAY_FRAME_INTERVAL_MS
      ) {
        // Mobile networks can release queued WebSocket frames in a burst even
        // when the browser encoded them one second apart. Drop that frame
        // without tearing down the authenticated broadcast; the combined
        // per-socket limit above still closes sustained abuse.
        return;
      }

      attachment.lastRelayFrameAt = now;
      socket.serializeAttachment(attachment);
      const snapshot = liveRoomSnapshot(this.state);
      for (const viewer of snapshot.viewers) {
        if (
          viewer.state.relayRequested &&
          !viewer.state.relayAwaitingAck
        ) {
          viewer.state.relayAwaitingAck = true;
          viewer.socket.serializeAttachment(viewer.state);
          if (!sendLiveBinary(viewer.socket, message)) {
            viewer.state.relayAwaitingAck = false;
            viewer.socket.serializeAttachment(viewer.state);
          }
        }
      }
      return;
    }

    let signal: ReturnType<typeof parseLiveSignal>;
    try {
      signal = parseLiveSignal(message);
    } catch (error) {
      if (error instanceof ApiError) {
        closeLiveSocket(
          socket,
          error.status,
          error.code,
          error.message,
        );
      } else {
        closeLiveSocket(
          socket,
          1008,
          "INVALID_SIGNAL",
          "실시간 연결 메시지가 올바르지 않습니다.",
        );
      }
      return;
    }

    if (signal.type === "join") {
      if (attachment.role !== "pending") {
        closeLiveSocket(
          socket,
          1008,
          "ALREADY_JOINED",
          "이미 실시간 관제실에 참여했습니다.",
        );
        return;
      }
      const beforeJoin = liveRoomSnapshot(this.state);
      if (signal.role === "broadcaster" && beforeJoin.broadcaster) {
        closeLiveSocket(
          socket,
          1008,
          "BROADCASTER_ALREADY_CONNECTED",
          "이미 현장 영상이 송출 중입니다.",
        );
        return;
      }
      if (
        signal.role === "viewer" &&
        beforeJoin.viewers.length >= MAX_LIVE_VIEWERS
      ) {
        closeLiveSocket(
          socket,
          1008,
          "VIEWER_LIMIT_REACHED",
          "동시에 접속할 수 있는 관제 화면은 최대 3대입니다.",
        );
        return;
      }

      attachment.role = signal.role;
      socket.serializeAttachment(attachment);
      const afterJoin = liveRoomSnapshot(this.state);
      sendLiveMessage(socket, {
        type: "status",
        status: "joined",
        peerId: attachment.peerId,
        role: attachment.role,
        broadcasterOnline: afterJoin.broadcaster !== null,
        viewerCount: afterJoin.viewers.length,
        maxViewers: MAX_LIVE_VIEWERS,
      });
      broadcastLiveRoomStatus(this.state);

      if (attachment.role === "viewer" && afterJoin.broadcaster) {
        sendLiveMessage(afterJoin.broadcaster.socket, {
          type: "viewer-joined",
          viewerId: attachment.peerId,
        });
      } else if (attachment.role === "broadcaster") {
        for (const viewer of afterJoin.viewers) {
          sendLiveMessage(socket, {
            type: "viewer-joined",
            viewerId: viewer.state.peerId,
          });
          if (viewer.state.relayRequested) {
            sendLiveMessage(socket, {
              type: "relay-request",
              from: viewer.state.peerId,
            });
          }
        }
      }
      return;
    }

    if (attachment.role === "pending") {
      closeLiveSocket(
        socket,
        1008,
        "JOIN_REQUIRED",
        "먼저 실시간 관제실 참여 메시지를 보내야 합니다.",
      );
      return;
    }

    const snapshot = liveRoomSnapshot(this.state);
    if (
      signal.type === "relay-request" ||
      signal.type === "relay-stop" ||
      signal.type === "relay-ack"
    ) {
      if (attachment.role !== "viewer") {
        closeLiveSocket(
          socket,
          1008,
          "ROLE_NOT_ALLOWED",
          "관제 화면만 대체 영상 중계를 제어할 수 있습니다.",
        );
        return;
      }
      if (signal.type === "relay-ack") {
        if (!attachment.relayRequested) {
          closeLiveSocket(
            socket,
            1008,
            "RELAY_NOT_REQUESTED",
            "대체 영상 중계를 먼저 요청해야 합니다.",
          );
          return;
        }
        if (!attachment.relayAwaitingAck) {
          closeLiveSocket(
            socket,
            1008,
            "RELAY_ACK_NOT_PENDING",
            "확인할 대체 영상 프레임이 없습니다.",
          );
          return;
        }
        attachment.relayAwaitingAck = false;
        const firstAcknowledgement = !attachment.relayAcknowledged;
        attachment.relayAcknowledged = true;
        socket.serializeAttachment(attachment);
        if (firstAcknowledgement && snapshot.broadcaster) {
          sendLiveMessage(snapshot.broadcaster.socket, {
            type: "relay-live",
            from: attachment.peerId,
          });
        }
        return;
      }

      attachment.relayRequested = signal.type === "relay-request";
      attachment.relayAwaitingAck = false;
      attachment.relayAcknowledged = false;
      socket.serializeAttachment(attachment);
      if (snapshot.broadcaster) {
        sendLiveMessage(snapshot.broadcaster.socket, {
          type: signal.type,
          from: attachment.peerId,
        });
      }
      return;
    }
    if (signal.type === "offer") {
      if (attachment.role !== "broadcaster") {
        closeLiveSocket(
          socket,
          1008,
          "ROLE_NOT_ALLOWED",
          "현장 송출자만 영상 연결 제안을 보낼 수 있습니다.",
        );
        return;
      }
      const target = findLivePeer(snapshot, signal.target, "viewer");
      if (!target) {
        sendLiveError(
          socket,
          "TARGET_NOT_FOUND",
          "연결할 관제 화면을 찾을 수 없습니다.",
          signal.target,
        );
        return;
      }
      sendLiveMessage(target.socket, {
        type: "offer",
        from: attachment.peerId,
        sdp: signal.sdp,
      });
      return;
    }
    if (signal.type === "answer") {
      if (attachment.role !== "viewer") {
        closeLiveSocket(
          socket,
          1008,
          "ROLE_NOT_ALLOWED",
          "관제 화면만 영상 연결 응답을 보낼 수 있습니다.",
        );
        return;
      }
      const target = findLivePeer(snapshot, signal.target, "broadcaster");
      if (!target) {
        sendLiveError(
          socket,
          "TARGET_NOT_FOUND",
          "현장 송출 연결을 찾을 수 없습니다.",
          signal.target,
        );
        return;
      }
      sendLiveMessage(target.socket, {
        type: "answer",
        from: attachment.peerId,
        sdp: signal.sdp,
      });
      return;
    }
    if (signal.type === "ice") {
      const targetRole =
        attachment.role === "broadcaster" ? "viewer" : "broadcaster";
      const target = findLivePeer(snapshot, signal.target, targetRole);
      if (!target) {
        sendLiveError(
          socket,
          "TARGET_NOT_FOUND",
          "실시간 영상 연결 상대를 찾을 수 없습니다.",
          signal.target,
        );
        return;
      }
      sendLiveMessage(target.socket, {
        type: "ice",
        from: attachment.peerId,
        candidate: signal.candidate,
      });
      return;
    }

    for (const peer of [
      ...(snapshot.broadcaster ? [snapshot.broadcaster] : []),
      ...snapshot.viewers,
    ]) {
      if (peer.state.peerId !== attachment.peerId) {
        sendLiveMessage(peer.socket, {
          type: "status",
          status: "peer-state",
          peerId: attachment.peerId,
          role: attachment.role,
          state: signal.state,
        });
      }
    }
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ) {
    this.notifyPeerLeft(socket);
    if (socket.readyState !== 3) {
      try {
        socket.close(code, reason.slice(0, 120));
      } catch {
        // The runtime may already have completed the close handshake.
      }
    }
    await this.scheduleNextSessionAlarm(socket);
  }

  async webSocketError(socket: WebSocket) {
    this.notifyPeerLeft(socket);
    if (socket.readyState !== 3) {
      try {
        socket.close(1011, "LIVE_SOCKET_ERROR");
      } catch {
        // The connection is already unavailable.
      }
    }
    await this.scheduleNextSessionAlarm(socket);
  }

  async alarm() {
    const now = Date.now();
    for (const socket of this.state.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const attachment = readLiveAttachment(socket);
      if (attachment && attachment.sessionExpiresAt <= now) {
        closeLiveSocket(
          socket,
          4401,
          "SESSION_EXPIRED",
          "관제 인증이 만료되었습니다.",
        );
      }
    }
    await this.scheduleNextSessionAlarm();
  }

  private notifyPeerLeft(socket: WebSocket) {
    const attachment = readLiveAttachment(socket);
    if (!attachment || attachment.role === "pending") return;
    const snapshot = liveRoomSnapshot(this.state, socket);
    const peers = [
      ...(snapshot.broadcaster ? [snapshot.broadcaster] : []),
      ...snapshot.viewers,
    ];
    if (attachment.role === "broadcaster") {
      for (const viewer of snapshot.viewers) {
        viewer.state.relayRequested = false;
        viewer.state.relayAwaitingAck = false;
        viewer.state.relayAcknowledged = false;
        viewer.socket.serializeAttachment(viewer.state);
      }
    }
    for (const peer of peers) {
      if (peer.state.peerId !== attachment.peerId) {
        sendLiveMessage(peer.socket, {
          type: "peer-left",
          peerId: attachment.peerId,
          role: attachment.role,
        });
      }
    }
    broadcastLiveRoomStatus(this.state, socket);
  }

  private async scheduleNextSessionAlarm(excludedSocket?: WebSocket) {
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const socket of this.state.getWebSockets()) {
      if (socket === excludedSocket || socket.readyState !== 1) continue;
      const attachment = readLiveAttachment(socket);
      if (attachment) {
        nextExpiry = Math.min(nextExpiry, attachment.sessionExpiresAt);
      }
    }
    if (Number.isFinite(nextExpiry)) {
      await this.state.storage.setAlarm(nextExpiry);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }
}

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    if (url.pathname === "/_vinext/image" && env.IMAGES && env.ASSETS) {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return securePageResponse(
        await handleImageOptimization(
          request,
          {
            fetchAsset: (path) =>
              env.ASSETS.fetch(new Request(new URL(path, request.url))),
            transformImage: async (body, { width, format, quality }) => {
              const result = await env.IMAGES!.input(body)
                .transform(width > 0 ? { width } : {})
                .output({ format, quality });
              return result.response();
            },
          },
          allowedWidths,
        ),
      );
    }

    return securePageResponse(await handler.fetch(request, env, ctx));
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: WorkerExecutionContext,
  ) {
    ctx.waitUntil(
      cleanupExpiredEvents(env).catch((error) => {
        console.error("SAFEBOT scheduled cleanup failed", error);
      }),
    );
  },
};

export default worker;
