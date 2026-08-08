"use client";

import {
  BellRing,
  Bot,
  CheckCircle2,
  Clock3,
  EyeOff,
  History,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MapPin,
  MonitorUp,
  Play,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  Video,
  Wifi,
  X,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useLiveViewer } from "./use-live-viewer";

type AuthState = "checking" | "signed_out" | "signed_in" | "unavailable";

type ControlEvent = {
  id: string;
  status: "emergency" | "recovered" | "false_positive" | "interrupted";
  title: string;
  detail: string;
  createdAt: string;
  durationSeconds: number;
  confidence: number;
  notification: string;
  deviceId: string;
  clipAvailable: boolean;
  posterAvailable: boolean;
  clipState: string;
  mimeType: string;
  bytes: number;
  expiresAt: string | null;
};

type RawEvent = Record<string, unknown>;

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function boolValue(value: unknown) {
  return value === true || value === 1;
}

function normalizeEvent(raw: RawEvent): ControlEvent {
  const status = textValue(raw.status, "interrupted");
  return {
    id: textValue(raw.id),
    status:
      status === "emergency" ||
      status === "recovered" ||
      status === "false_positive"
        ? status
        : "interrupted",
    title: textValue(raw.title, "안전 이벤트"),
    detail: textValue(raw.detail, "현장 확인이 필요한 이벤트입니다."),
    createdAt: textValue(
      raw.createdAt ?? raw.created_at,
      new Date().toISOString(),
    ),
    durationSeconds: numberValue(
      raw.durationSeconds ?? raw.duration_seconds,
    ),
    confidence: numberValue(raw.confidence),
    notification: textValue(raw.notification),
    deviceId: textValue(raw.deviceId ?? raw.device_id, "모바일 순찰 01"),
    clipAvailable: boolValue(
      raw.clipAvailable ??
        raw.clip_available ??
        raw.clipKey ??
        raw.clip_key,
    ),
    posterAvailable: boolValue(
      raw.posterAvailable ??
        raw.poster_available ??
        raw.posterKey ??
        raw.poster_key,
    ),
    clipState: textValue(raw.clipState ?? raw.clip_state, "stored"),
    mimeType: textValue(raw.mimeType ?? raw.mime_type),
    bytes: numberValue(raw.bytes),
    expiresAt:
      textValue(raw.expiresAt ?? raw.expires_at) || null,
  };
}

function formatDateTime(iso: string) {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatBytes(bytes: number) {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function statusLabel(status: ControlEvent["status"]) {
  switch (status) {
    case "emergency":
      return "관제 확인 필요";
    case "recovered":
      return "상태 회복";
    case "false_positive":
      return "오탐 취소";
    case "interrupted":
      return "확인 중단";
  }
}

export default function ControlCenter() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [events, setEvents] = useState<ControlEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<ControlEvent | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const {
    videoRef: liveVideoRef,
    state: liveViewerState,
    hasStream: hasLiveStream,
    isLive,
    transport: liveTransport,
    relayFrameUrl,
    reconnect: reconnectLiveViewer,
  } = useLiveViewer(authState === "signed_in");

  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const response = await fetch("/api/events", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setAuthState("signed_out");
        setEvents([]);
        return;
      }
      if (!response.ok) {
        throw new Error("관제 이력을 불러오지 못했습니다.");
      }
      const payload = (await response.json()) as
        | RawEvent[]
        | { events?: RawEvent[] };
      const rows = Array.isArray(payload) ? payload : payload.events ?? [];
      setEvents(rows.map(normalizeEvent).filter((event) => event.id));
      setLastUpdated(new Date());
    } catch {
      setAuthError("서버 이력을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!active) return;
        if (response.status === 503) {
          setAuthState("unavailable");
          return;
        }
        const payload = (await response.json().catch(() => ({}))) as {
          authenticated?: boolean;
          configured?: boolean;
        };
        setAuthState(
          payload.configured === false
            ? "unavailable"
            : payload.authenticated
              ? "signed_in"
              : "signed_out",
        );
      })
      .catch(() => {
        if (active) setAuthState("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (authState !== "signed_in") return;
    const initialLoad = window.setTimeout(loadEvents, 0);
    const interval = window.setInterval(loadEvents, 15_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [authState, loadEvents]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
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
      setPassword("");
      setAuthState("signed_in");
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : "관제센터에 로그인하지 못했습니다.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
    setEvents([]);
    setSelectedEvent(null);
    setAuthState("signed_out");
  };

  const emergencyEvents = useMemo(
    () => events.filter((event) => event.status === "emergency"),
    [events],
  );
  const todayCount = useMemo(() => {
    const today = new Date().toDateString();
    return events.filter(
      (event) => new Date(event.createdAt).toDateString() === today,
    ).length;
  }, [events]);
  const latestEvent = events[0] ?? null;
  const liveStatusLabel =
    liveViewerState === "live"
      ? liveTransport === "relay"
        ? "저속 RELAY · 1fps"
        : "절약형 LIVE · 360p"
      : liveViewerState === "connecting"
        ? "실시간 연결 중"
        : "현장기기 오프라인";

  return (
    <main className="control-root">
      <header className="control-topbar">
        <Link className="brand" href="/control" aria-label="고양 폴리봇 관제센터 홈">
          <span className="brand-mark">
            <ShieldCheck size={21} strokeWidth={2.3} aria-hidden="true" />
          </span>
          <span>
            <strong>고양 폴리봇</strong>
            <small>SAFEBOT 통합관제센터</small>
          </span>
        </Link>
        <div className="topbar-actions">
          <span
            className={`connection-pill ${authState === "signed_in" ? "is-live" : ""}`}
          >
            <span className="status-dot" />
            {authState === "signed_in" ? "보안 연결됨" : "관제 연결 대기"}
          </span>
          <Link className="button button-ghost control-device-link" href="/">
            <Smartphone size={16} aria-hidden="true" />
            현장기기
          </Link>
          {authState === "signed_in" && (
            <button
              className="icon-button"
              onClick={logout}
              aria-label="관제센터 로그아웃"
              title="로그아웃"
            >
              <LogOut size={19} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {authState === "checking" && (
        <section className="control-auth-shell" aria-live="polite">
          <div className="control-auth-card is-loading">
            <LoaderCircle className="spin" size={30} aria-hidden="true" />
            <h1>보안 연결을 확인하고 있습니다</h1>
            <p>관제 영상과 이벤트 이력은 인증된 담당자에게만 표시됩니다.</p>
          </div>
        </section>
      )}

      {(authState === "signed_out" || authState === "unavailable") && (
        <section className="control-auth-shell">
          <div className="control-auth-intro">
            <span className="eyebrow">
              <MonitorUp size={14} aria-hidden="true" />
              CONTROL CENTER
            </span>
            <h1>현장의 안전 신호를<br />관제센터에서 확인합니다.</h1>
            <p>
              현장기기에서 10초간 확인된 이벤트와 얼굴이 흐림 처리된 영상을
              인증된 관제 담당자만 볼 수 있습니다.
            </p>
            <div className="control-trust-list">
              <span>
                <LockKeyhole size={17} aria-hidden="true" />
                비공개 영상 저장
              </span>
              <span>
                <EyeOff size={17} aria-hidden="true" />
                원본·음성 저장 안 함
              </span>
              <span>
                <Clock3 size={17} aria-hidden="true" />
                7일 후 자동 삭제
              </span>
            </div>
          </div>

          <form className="control-auth-card" onSubmit={login}>
            <div className="control-auth-icon">
              <KeyRound size={24} aria-hidden="true" />
            </div>
            <span className="eyebrow">AUTHORIZED ACCESS</span>
            <h2>관제 담당자 로그인</h2>
            <p>발급된 관제 접속 코드를 입력해 주세요.</p>
            <label htmlFor="control-password">관제 접속 코드</label>
            <input
              id="control-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="접속 코드 입력"
              autoComplete="current-password"
              disabled={authState === "unavailable" || submitting}
              required
            />
            {authError && (
              <div className="control-auth-error" role="alert">
                <TriangleAlert size={16} aria-hidden="true" />
                {authError}
              </div>
            )}
            {authState === "unavailable" && (
              <div className="control-auth-error" role="status">
                <TriangleAlert size={16} aria-hidden="true" />
                관제 저장 서버를 준비 중입니다. 현장기기의 로컬 감지는 계속
                사용할 수 있습니다.
              </div>
            )}
            <button
              className="button button-primary control-login-button"
              type="submit"
              disabled={authState === "unavailable" || submitting}
            >
              {submitting ? (
                <LoaderCircle className="spin" size={17} aria-hidden="true" />
              ) : (
                <LockKeyhole size={17} aria-hidden="true" />
              )}
              관제센터 접속
            </button>
            <Link className="control-local-link" href="/">
              현장기기 카메라 테스트로 이동
            </Link>
          </form>
        </section>
      )}

      {authState === "signed_in" && (
        <div className="control-workspace">
          <section className="control-heading">
            <div>
              <span className="eyebrow">
                <Radio size={14} aria-hidden="true" />
                SAFETY OPERATIONS
              </span>
              <h1>주민안전 관제 현황</h1>
              <p>
                현장의 실시간 영상과 쓰러짐 확정 이벤트를 함께 확인하고 대응을
                판단합니다.
              </p>
            </div>
            <button
              className="button button-ghost"
              onClick={() => void loadEvents()}
              disabled={loadingEvents}
            >
              <RefreshCw
                className={loadingEvents ? "spin" : ""}
                size={16}
                aria-hidden="true"
              />
              새로고침
            </button>
          </section>

          <section className="control-metrics" aria-label="관제 현황 요약">
            <article>
              <span className="control-metric-icon red">
                <BellRing size={20} aria-hidden="true" />
              </span>
              <div>
                <small>확인 필요 이벤트</small>
                <strong>{emergencyEvents.length}<i>건</i></strong>
              </div>
            </article>
            <article>
              <span className="control-metric-icon primary">
                <History size={20} aria-hidden="true" />
              </span>
              <div>
                <small>오늘 수신</small>
                <strong>{todayCount}<i>건</i></strong>
              </div>
            </article>
            <article>
              <span className="control-metric-icon blue">
                <Bot size={20} aria-hidden="true" />
              </span>
              <div>
                <small>등록 현장기기</small>
                <strong>{isLive || events.length ? 1 : 0}<i>대</i></strong>
              </div>
            </article>
            <article>
              <span className="control-metric-icon violet">
                <Wifi size={20} aria-hidden="true" />
              </span>
              <div>
                <small>서버 상태</small>
                <strong className="metric-word">정상</strong>
              </div>
            </article>
          </section>

          <section className="control-grid">
            <article className="control-preview-card">
              <div className="control-card-heading">
                <div>
                  <span className="eyebrow">LIVE CONTROL</span>
                  <h2>현장 실시간 관제</h2>
                </div>
                {isLive ? (
                  <span
                    className="device-online"
                    role="status"
                    aria-live="polite"
                  >
                    <span />
                    {liveStatusLabel}
                  </span>
                ) : (
                  <span
                    className="control-status"
                    role="status"
                    aria-live="polite"
                  >
                    {liveStatusLabel}
                  </span>
                )}
              </div>
              {hasLiveStream ? (
                <div
                  className="control-preview"
                  style={{ cursor: "default" }}
                >
                  <video
                    ref={liveVideoRef}
                    controls={liveTransport !== "relay"}
                    autoPlay
                    muted
                    playsInline
                    aria-label="현장기기 실시간 영상"
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      opacity: liveTransport === "relay" ? 0 : 1,
                      pointerEvents:
                        liveTransport === "relay" ? "none" : "auto",
                    }}
                  />
                  {liveTransport === "relay" && relayFrameUrl && (
                    // This short-lived blob URL contains only the anonymized
                    // canvas frame relayed in memory; it is never persisted.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={relayFrameUrl}
                      alt="무료 저속 중계로 수신한 익명화 현장 화면"
                      style={{
                        position: "absolute",
                        inset: 0,
                        zIndex: 1,
                      }}
                    />
                  )}
                  <span
                    className="control-play"
                    aria-hidden="true"
                    style={{
                      top: 15,
                      bottom: "auto",
                      pointerEvents: "none",
                    }}
                  >
                    <Radio size={17} aria-hidden="true" />
                    {liveStatusLabel}
                  </span>
                </div>
              ) : latestEvent ? (
                <button
                  className="control-preview"
                  onClick={() =>
                    latestEvent.clipAvailable && setSelectedEvent(latestEvent)
                  }
                  disabled={!latestEvent.clipAvailable}
                  aria-label={
                    latestEvent.clipAvailable
                      ? "최근 이벤트 10초 영상 재생"
                      : "최근 이벤트 영상 없음"
                  }
                >
                  {latestEvent.posterAvailable ? (
                    // The poster endpoint is authenticated and returns only
                    // the device-anonymized frame.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/events/${encodeURIComponent(latestEvent.id)}/poster`}
                      alt="얼굴이 익명화된 최근 현장 이벤트"
                    />
                  ) : (
                    <div className="control-preview-placeholder">
                      <Video size={34} aria-hidden="true" />
                      <span>익명화 영상 이벤트</span>
                    </div>
                  )}
                  {latestEvent.clipAvailable && (
                    <span className="control-play">
                      <Play size={19} fill="currentColor" aria-hidden="true" />
                      10초 영상 보기
                    </span>
                  )}
                </button>
              ) : (
                <div className="control-empty-preview">
                  <ShieldCheck size={34} aria-hidden="true" />
                  <h3>수신된 안전 이벤트가 없습니다</h3>
                  <p>현장기기에서 확정된 이벤트가 발생하면 여기에 표시됩니다.</p>
                </div>
              )}
              <div className="control-stream-note">
                <Radio size={17} aria-hidden="true" />
                <div>
                  <strong>
                    {isLive
                      ? liveTransport === "relay"
                        ? "무료 저속 안전 중계 수신 중"
                        : "현장 실시간 영상 수신 중"
                      : liveViewerState === "connecting"
                        ? "실시간 영상 연결 중"
                        : "현장기기 오프라인"}
                  </strong>
                  <p>
                    {isLive
                      ? liveTransport === "relay"
                        ? "직접 연결이 막힌 네트워크에서 익명화된 무음 화면만 초당 1장으로 임시 중계합니다. 중계 프레임은 서버에 저장하지 않습니다."
                        : "Cloudflare TURN을 지원하는 절약형 WebRTC로 익명화된 무음 영상을 최대 360p·12fps·350kbps로 수신합니다. 확정된 10초 사건 영상은 아래 이력에도 계속 보관됩니다."
                      : "실시간 영상이 없을 때는 가장 최근에 저장된 10초 사건 영상을 표시합니다."}
                  </p>
                  {!isLive && (
                    <button
                      className="button button-ghost"
                      type="button"
                      onClick={reconnectLiveViewer}
                      aria-label="현장 실시간 영상 다시 연결"
                      style={{ justifySelf: "start", marginTop: 6 }}
                    >
                      <RefreshCw size={15} aria-hidden="true" />
                      다시 연결
                    </button>
                  )}
                </div>
              </div>
            </article>

            <article className="control-device-card">
              <div className="control-card-heading">
                <div>
                  <span className="eyebrow">FIELD DEVICE</span>
                  <h2>현장기기 상태</h2>
                </div>
                {isLive ? (
                  <span className="device-online">
                    <span />
                    {liveTransport === "relay"
                      ? "저속 중계 연결됨"
                      : "절약형 실시간 연결됨"}
                  </span>
                ) : (
                  <span className="control-status">{liveStatusLabel}</span>
                )}
              </div>
              <div className="device-identity">
                <span>
                  <Smartphone size={23} aria-hidden="true" />
                </span>
                <div>
                  <strong>{latestEvent?.deviceId || "모바일 순찰 01"}</strong>
                  <small>일반 외부 환경 · Edge AI</small>
                </div>
              </div>
              <dl className="device-details">
                <div>
                  <dt>최근 수신</dt>
                  <dd>
                    {isLive
                      ? "실시간 수신 중"
                      : latestEvent
                      ? formatDateTime(latestEvent.createdAt)
                      : "수신 대기"}
                  </dd>
                </div>
                <div>
                  <dt>영상 정책</dt>
                  <dd>익명화 · 무음 · 10초</dd>
                </div>
                <div>
                  <dt>보관 정책</dt>
                  <dd>확정 이벤트만 7일</dd>
                </div>
              </dl>
              <Link className="button button-dark" href="/">
                <Smartphone size={17} aria-hidden="true" />
                현장기기 화면 열기
              </Link>
            </article>
          </section>

          <section className="control-history">
            <div className="control-card-heading">
              <div>
                <span className="eyebrow">EVENT HISTORY</span>
                <h2>안전 이벤트 이력</h2>
                <p>
                  로그인한 관제 담당자만 서버에 보관된 영상을 재생할 수
                  있습니다.
                </p>
              </div>
              <small>
                {lastUpdated
                  ? `${lastUpdated.toLocaleTimeString("ko-KR")} 갱신`
                  : "불러오는 중"}
              </small>
            </div>

            {loadingEvents && events.length === 0 ? (
              <div className="control-empty-list">
                <LoaderCircle className="spin" size={26} aria-hidden="true" />
                <span>이벤트 이력을 불러오고 있습니다.</span>
              </div>
            ) : events.length === 0 ? (
              <div className="control-empty-list">
                <CheckCircle2 size={28} aria-hidden="true" />
                <strong>현재 확인할 이벤트가 없습니다</strong>
                <span>새 이벤트가 수신되면 자동으로 갱신됩니다.</span>
              </div>
            ) : (
              <div className="control-event-list">
                {events.map((event) => (
                  <article
                    className={`control-event status-${event.status}`}
                    key={event.id}
                  >
                    <div className="control-event-poster">
                      {event.posterAvailable ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/events/${encodeURIComponent(event.id)}/poster`}
                          alt="얼굴이 익명화된 이벤트 미리보기"
                        />
                      ) : (
                        <span>
                          {event.status === "emergency" ? (
                            <BellRing size={21} aria-hidden="true" />
                          ) : (
                            <CheckCircle2 size={21} aria-hidden="true" />
                          )}
                        </span>
                      )}
                    </div>
                    <div className="control-event-copy">
                      <div className="control-event-meta">
                        <span>
                          <MapPin size={13} aria-hidden="true" />
                          {event.deviceId}
                        </span>
                        <span>
                          <Clock3 size={13} aria-hidden="true" />
                          {formatDateTime(event.createdAt)}
                        </span>
                      </div>
                      <h3>{event.title}</h3>
                      <p>{event.detail}</p>
                    </div>
                    <div className="control-event-data">
                      <span className={`control-status status-${event.status}`}>
                        {statusLabel(event.status)}
                      </span>
                      <small>
                        {event.durationSeconds || 0}초 ·{" "}
                        {Math.round(event.confidence * 100)}% ·{" "}
                        {formatBytes(event.bytes)}
                      </small>
                      <button
                        className="button button-ghost"
                        onClick={() => setSelectedEvent(event)}
                        disabled={!event.clipAvailable}
                      >
                        <Play size={15} fill="currentColor" aria-hidden="true" />
                        {event.clipAvailable ? "영상 보기" : "영상 없음"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {selectedEvent && (
        <div
          className="clip-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setSelectedEvent(null);
          }}
        >
          <section
            className="clip-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="control-clip-title"
          >
            <div className="clip-modal-heading">
              <div>
                <span className="eyebrow">ANONYMIZED EVENT CLIP</span>
                <h2 id="control-clip-title">{selectedEvent.title}</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setSelectedEvent(null)}
                aria-label="영상 닫기"
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>
            <video
              key={selectedEvent.id}
              controls
              autoPlay
              playsInline
              preload="metadata"
              poster={
                selectedEvent.posterAvailable
                  ? `/api/events/${encodeURIComponent(selectedEvent.id)}/poster`
                  : undefined
              }
              src={`/api/events/${encodeURIComponent(selectedEvent.id)}/clip`}
            />
            <div className="clip-modal-meta">
              <span>
                <MapPin size={14} aria-hidden="true" />
                {selectedEvent.deviceId}
              </span>
              <span>
                <Clock3 size={14} aria-hidden="true" />
                {formatDateTime(selectedEvent.createdAt)}
              </span>
              <span>
                <EyeOff size={14} aria-hidden="true" />
                얼굴 흐림 · 음성 없음
              </span>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
