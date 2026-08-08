export const FMS_API_BASE_URL =
  "https://gaemi0-fms-site.robotis.com:11000";
export const FMS_LIVEKIT_URL =
  "wss://gaemi0-fms-site.robotis.com:11001";

const FMS_OPERATION_MODE = "pilotMode" as const;
const MAX_CREDENTIAL_LENGTH = 1_024;
const MAX_TOKEN_LENGTH = 128 * 1_024;
const MAX_IDENTITY_LENGTH = 256;

export type FmsErrorCode =
  | "aborted"
  | "authentication_failed"
  | "invalid_input"
  | "invalid_response"
  | "network_error"
  | "not_authenticated"
  | "rate_limited"
  | "request_failed"
  | "session_expired";

export class FmsClientError extends Error {
  readonly code: FmsErrorCode;
  readonly status: number | null;

  constructor(code: FmsErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "FmsClientError";
    this.code = code;
    this.status = status;
  }
}

export type FmsProfile = {
  uid: string;
  name: string;
  email: string;
};

export type FmsLiveKitConnection = {
  url: string;
  token: string;
  roomName: string;
  participantIdentity: string;
};

export type FmsRequestOptions = {
  signal?: AbortSignal;
};

export type FmsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FmsClientOptions = {
  fetchImpl?: FmsFetch;
};

export type FmsLoginInput = {
  email: string;
  password: string;
};

export type FmsLiveKitTokenInput = {
  robotId: number | string;
  participantIdentity: string;
};

type RequestOperation = "login" | "authenticated";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 && result.length <= maximumLength ? result : null;
}

function requiredUid(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return requiredString(value, MAX_IDENTITY_LENGTH);
}

function responseData(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  return payload.data;
}

function abortedError() {
  return new FmsClientError("aborted", "FMS 요청이 취소되었습니다.");
}

/**
 * Converts an FMS numeric robot id into the LiveKit room naming convention.
 * Already-normalized values are accepted so callers can safely normalize twice.
 */
export function normalizeFmsRobotRoomName(robotId: number | string): string {
  let value: string;
  if (typeof robotId === "number") {
    if (!Number.isSafeInteger(robotId) || robotId < 0) {
      throw new FmsClientError(
        "invalid_input",
        "로봇 식별자가 올바르지 않습니다.",
      );
    }
    value = String(robotId);
  } else {
    value = robotId.trim();
  }

  if (/^\d{1,64}$/u.test(value)) return `fms-robot-${value}`;
  if (/^fms-robot-\d{1,64}$/u.test(value)) return value;
  throw new FmsClientError(
    "invalid_input",
    "로봇 식별자가 올바르지 않습니다.",
  );
}

/**
 * Browser-side adapter for the ROBOTIS FMS API.
 *
 * The access token intentionally lives only in this instance. It is never
 * written to cookies, localStorage, sessionStorage, logs, or request URLs.
 */
export class FmsClient {
  private readonly fetchImpl: FmsFetch;
  #accessToken: string | null = null;

  constructor(options: FmsClientOptions = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new FmsClientError(
        "request_failed",
        "이 브라우저에서는 FMS 연결을 사용할 수 없습니다.",
      );
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  get isAuthenticated() {
    return this.#accessToken !== null;
  }

  clearSession() {
    this.#accessToken = null;
  }

  async login(
    input: FmsLoginInput,
    options: FmsRequestOptions = {},
  ): Promise<void> {
    this.clearSession();
    const email = requiredString(input.email, MAX_CREDENTIAL_LENGTH);
    const password =
      typeof input.password === "string" &&
      input.password.length > 0 &&
      input.password.length <= MAX_CREDENTIAL_LENGTH
        ? input.password
        : null;
    if (!email || !password) {
      throw new FmsClientError(
        "invalid_input",
        "FMS 계정 정보를 입력해 주세요.",
      );
    }

    const payload = await this.requestJson(
      "/v1/auth/login",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      },
      "login",
      options.signal,
    );
    const token = requiredString(
      responseData(payload)?.accessToken,
      MAX_TOKEN_LENGTH,
    );
    if (!token) {
      throw new FmsClientError(
        "invalid_response",
        "FMS 서버 응답을 확인할 수 없습니다.",
      );
    }
    this.#accessToken = token;
  }

  async getProfile(options: FmsRequestOptions = {}): Promise<FmsProfile> {
    const payload = await this.authenticatedRequest(
      "/v1/auth/profile",
      { method: "GET" },
      options.signal,
    );
    const data = responseData(payload);
    const uid = requiredUid(data?.uid);
    const name = requiredString(data?.name, MAX_IDENTITY_LENGTH);
    const email = requiredString(data?.email, MAX_CREDENTIAL_LENGTH);
    if (!uid || !name || !email) {
      throw new FmsClientError(
        "invalid_response",
        "FMS 서버 응답을 확인할 수 없습니다.",
      );
    }
    return { uid, name, email };
  }

  async requestLiveKitToken(
    input: FmsLiveKitTokenInput,
    options: FmsRequestOptions = {},
  ): Promise<FmsLiveKitConnection> {
    const roomName = normalizeFmsRobotRoomName(input.robotId);
    const participantIdentity = requiredString(
      input.participantIdentity,
      MAX_IDENTITY_LENGTH,
    );
    if (!participantIdentity) {
      throw new FmsClientError(
        "invalid_input",
        "참여자 식별자가 올바르지 않습니다.",
      );
    }

    const payload = await this.authenticatedRequest(
      "/v1/webrtc-server/token",
      {
        method: "POST",
        body: JSON.stringify({
          roomName,
          participantIdentity,
          operationMode: FMS_OPERATION_MODE,
        }),
      },
      options.signal,
    );
    const token = requiredString(
      responseData(payload)?.token,
      MAX_TOKEN_LENGTH,
    );
    if (!token) {
      throw new FmsClientError(
        "invalid_response",
        "FMS 서버 응답을 확인할 수 없습니다.",
      );
    }
    return {
      url: FMS_LIVEKIT_URL,
      token,
      roomName,
      participantIdentity,
    };
  }

  private async authenticatedRequest(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ) {
    const token = this.#accessToken;
    if (!token) {
      throw new FmsClientError(
        "not_authenticated",
        "FMS에 먼저 로그인해 주세요.",
      );
    }

    return this.requestJson(
      path,
      {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
      },
      "authenticated",
      signal,
    );
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    operation: RequestOperation,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortedError();

    let response: Response;
    try {
      response = await this.fetchImpl(`${FMS_API_BASE_URL}${path}`, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        signal,
      });
    } catch {
      if (signal?.aborted) throw abortedError();
      throw new FmsClientError(
        "network_error",
        "FMS 서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.",
      );
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new FmsClientError(
          "rate_limited",
          "FMS 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
          response.status,
        );
      }
      if (response.status === 401 || response.status === 403) {
        if (operation === "login") {
          throw new FmsClientError(
            "authentication_failed",
            "FMS 계정 정보를 확인해 주세요.",
            response.status,
          );
        }
        this.clearSession();
        throw new FmsClientError(
          "session_expired",
          "FMS 연결이 만료되었습니다. 다시 로그인해 주세요.",
          response.status,
        );
      }
      throw new FmsClientError(
        "request_failed",
        operation === "login"
          ? "FMS 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요."
          : "FMS 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        response.status,
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      if (signal?.aborted) throw abortedError();
      throw new FmsClientError(
        "invalid_response",
        "FMS 서버 응답을 확인할 수 없습니다.",
      );
    }
  }
}
