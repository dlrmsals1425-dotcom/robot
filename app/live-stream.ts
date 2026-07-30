export type LiveBroadcastState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error"
  | "unsupported";

export type LiveBroadcastSnapshot = {
  state: LiveBroadcastState;
  viewerCount: number;
  message: string;
};

type LiveBroadcastOptions = {
  canvas: HTMLCanvasElement;
  onStatus: (snapshot: LiveBroadcastSnapshot) => void;
  onAuthenticationExpired?: () => void;
};

type SignalMessage = {
  type?: unknown;
  status?: unknown;
  state?: unknown;
  code?: unknown;
  message?: unknown;
  peerId?: unknown;
  viewerId?: unknown;
  from?: unknown;
  role?: unknown;
  viewerCount?: unknown;
  maxViewers?: unknown;
  sdp?: unknown;
  candidate?: unknown;
};

type PeerEntry = {
  connection: RTCPeerConnection;
  pendingCandidates: RTCIceCandidateInit[];
  negotiationTimer: number | null;
  disconnectedTimer: number | null;
};

const FRAME_RATE = 12;
const MAX_VIEWERS = 3;
const MAX_VIDEO_BITRATE = 600_000;
const MAX_RECONNECT_ATTEMPTS = 6;
const STABLE_SIGNALING_MS = 30_000;
const PEER_NEGOTIATION_TIMEOUT_MS = 15_000;
const PEER_DISCONNECTED_TIMEOUT_MS = 8_000;
const CLOUDFLARE_STUN_URL = "stun:stun.cloudflare.com:3478";

export const IDLE_LIVE_BROADCAST: LiveBroadcastSnapshot = {
  state: "idle",
  viewerCount: 0,
  message: "관제 실시간 공유 대기",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getViewerId(message: SignalMessage) {
  return (
    getString(message.from) ??
    getString(message.viewerId) ??
    getString(message.peerId)
  );
}

function parseSessionDescription(
  value: unknown,
  expectedType: RTCSdpType,
): RTCSessionDescriptionInit | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  const sdp = value.sdp;
  if (type !== expectedType || typeof sdp !== "string") return null;
  return { type: expectedType, sdp };
}

function parseIceCandidate(value: unknown): RTCIceCandidateInit | null {
  if (!isRecord(value) || typeof value.candidate !== "string") return null;
  return {
    candidate: value.candidate,
    sdpMid:
      typeof value.sdpMid === "string" || value.sdpMid === null
        ? value.sdpMid
        : undefined,
    sdpMLineIndex:
      typeof value.sdpMLineIndex === "number" ||
      value.sdpMLineIndex === null
        ? value.sdpMLineIndex
        : undefined,
    usernameFragment:
      typeof value.usernameFragment === "string"
        ? value.usernameFragment
        : undefined,
  };
}

function signalingUrl() {
  const url = new URL("/api/live/socket", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class LiveBroadcastSender {
  private readonly canvas: HTMLCanvasElement;
  private readonly onStatus: LiveBroadcastOptions["onStatus"];
  private readonly onAuthenticationExpired:
    | LiveBroadcastOptions["onAuthenticationExpired"];
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private peers = new Map<string, PeerEntry>();
  private reconnectTimer: number | null = null;
  private stabilityTimer: number | null = null;
  private reconnectAttempts = 0;
  private wanted = false;
  private disposed = false;
  private lastSnapshot = IDLE_LIVE_BROADCAST;

  constructor({
    canvas,
    onStatus,
    onAuthenticationExpired,
  }: LiveBroadcastOptions) {
    this.canvas = canvas;
    this.onStatus = onStatus;
    this.onAuthenticationExpired = onAuthenticationExpired;
  }

  start() {
    if (this.wanted || this.disposed) return;

    if (
      typeof WebSocket === "undefined" ||
      typeof RTCPeerConnection === "undefined" ||
      typeof this.canvas.captureStream !== "function"
    ) {
      this.emit({
        state: "unsupported",
        viewerCount: 0,
        message: "이 브라우저는 실시간 영상 공유를 지원하지 않습니다.",
      });
      return;
    }

    if (this.canvas.width <= 0 || this.canvas.height <= 0) {
      this.emit({
        state: "error",
        viewerCount: 0,
        message: "익명화 화면이 준비된 뒤 다시 시도해 주세요.",
      });
      return;
    }

    let capturedStream: MediaStream | null = null;
    try {
      capturedStream = this.canvas.captureStream(FRAME_RATE);
      // Canvas capture never contains audio. Stop defensively if a browser
      // implementation ever returns an unexpected audio track.
      capturedStream.getAudioTracks().forEach((track) => track.stop());
      const track = capturedStream.getVideoTracks()[0];
      if (!track) throw new Error("Missing canvas video track");
      try {
        track.contentHint = "motion";
      } catch {
        // Older mobile browsers can expose the property but reject writes.
      }
      track.addEventListener(
        "ended",
        () => {
          if (this.wanted) {
            this.fail("익명화 영상 트랙이 종료되어 공유를 중단했습니다.");
          }
        },
        { once: true },
      );
      this.stream = capturedStream;
    } catch {
      capturedStream?.getTracks().forEach((track) => track.stop());
      this.emit({
        state: "unsupported",
        viewerCount: 0,
        message: "이 기기에서 익명화 화면을 공유할 수 없습니다.",
      });
      return;
    }

    this.wanted = true;
    this.reconnectAttempts = 0;
    this.emit({
      state: "connecting",
      viewerCount: 0,
      message: "관제 실시간 공유를 연결하고 있습니다.",
    });
    this.connectSocket();
  }

  stop(emitStatus = true) {
    this.wanted = false;
    this.clearReconnectTimer();
    this.clearStabilityTimer();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1000, "broadcast stopped");
      }
    }

    this.closeAllPeers();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.reconnectAttempts = 0;

    if (emitStatus) this.emit(IDLE_LIVE_BROADCAST);
  }

  dispose() {
    this.stop(false);
    this.disposed = true;
  }

  private connectSocket() {
    if (!this.wanted || this.disposed) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(signalingUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      if (!this.wanted || this.socket !== socket) {
        socket.close(1000, "stale broadcast");
        return;
      }
      this.sendWithSocket(socket, {
        type: "join",
        role: "broadcaster",
      });
    };

    socket.onmessage = (event) => {
      if (!this.wanted || this.socket !== socket) return;
      if (typeof event.data !== "string") return;
      let message: SignalMessage;
      try {
        message = JSON.parse(event.data) as SignalMessage;
      } catch {
        return;
      }
      void this.handleSignal(message, socket);
    };

    socket.onerror = () => {
      // The close handler performs a bounded reconnect. Do not expose
      // low-level WebSocket details or signaling contents to the UI.
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearStabilityTimer();
      this.closeAllPeers();
      if (!this.wanted) return;

      if (
        event.code === 4001 ||
        event.code === 4401 ||
        event.code === 4403
      ) {
        this.onAuthenticationExpired?.();
        this.fail("관제 인증이 만료되어 실시간 공유를 종료했습니다.");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (!this.wanted || this.disposed || this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.fail("관제 서버에 다시 연결하지 못했습니다. 잠시 후 재시도해 주세요.");
      return;
    }

    const delay = Math.min(8_000, 800 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.emit({
      state: "reconnecting",
      viewerCount: 0,
      message: "관제 연결이 끊겨 안전하게 다시 연결하고 있습니다.",
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, delay);
  }

  private async handleSignal(message: SignalMessage, socket: WebSocket) {
    const type = getString(message.type);

    if (type === "status") {
      const status = getString(message.status) ?? getString(message.state);
      if (status === "error") {
        const code = getString(message.code);
        if (code === "AUTH_REQUIRED" || code === "SESSION_EXPIRED") {
          this.onAuthenticationExpired?.();
          this.fail("관제 인증이 만료되어 실시간 공유를 종료했습니다.");
        } else {
          this.fail(
            code === "BROADCASTER_ALREADY_CONNECTED"
              ? "다른 현장 기기가 이미 실시간 공유 중입니다."
              : "관제 서버가 실시간 공유를 시작하지 못했습니다.",
          );
        }
        return;
      }
      if (status === "connected") {
        this.emit({
          state: "connecting",
          viewerCount: 0,
          message: "관제 인증을 확인하고 방송 채널에 참여하고 있습니다.",
        });
        return;
      }
      if (
        status !== "joined" &&
        status !== "room-state"
      ) {
        return;
      }

      if (status === "joined") this.markSignalingStableLater(socket);
      // The server count means a viewer socket is present, not that media is
      // already flowing. Report only fully connected WebRTC viewers.
      this.emitLive();
      return;
    }

    if (type === "viewer-joined") {
      const viewerId = getString(message.viewerId);
      if (viewerId) await this.createPeer(viewerId, socket);
      return;
    }

    if (type === "answer") {
      const viewerId = getViewerId(message);
      const answer = parseSessionDescription(message.sdp, "answer");
      if (viewerId && answer) await this.applyAnswer(viewerId, answer);
      return;
    }

    if (type === "ice") {
      const viewerId = getViewerId(message);
      const candidate = parseIceCandidate(message.candidate);
      if (viewerId && candidate) await this.applyIce(viewerId, candidate);
      return;
    }

    if (type === "peer-left") {
      const peerId = getString(message.peerId);
      if (peerId && message.role === "viewer") this.closePeer(peerId);
      return;
    }

    if (type === "error") {
      const viewerId = getViewerId(message);
      const code = getString(message.code);
      if (code === "TARGET_NOT_FOUND") {
        if (viewerId) this.closePeer(viewerId);
        return;
      }
      this.fail(
        code === "BROADCASTER_ALREADY_CONNECTED"
          ? "다른 현장 기기가 이미 실시간 공유 중입니다."
          : "관제 서버가 실시간 공유 요청을 처리하지 못했습니다.",
      );
    }
  }

  private async createPeer(viewerId: string, socket: WebSocket) {
    if (
      !this.wanted ||
      this.socket !== socket ||
      this.peers.has(viewerId) ||
      this.peers.size >= MAX_VIEWERS
    ) {
      return;
    }

    const track = this.stream?.getVideoTracks()[0];
    if (!track || track.readyState !== "live") {
      this.fail("익명화 영상이 준비되지 않아 공유를 종료했습니다.");
      return;
    }

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: CLOUDFLARE_STUN_URL }],
      bundlePolicy: "max-bundle",
    });
    const entry: PeerEntry = {
      connection,
      pendingCandidates: [],
      negotiationTimer: null,
      disconnectedTimer: null,
    };
    this.peers.set(viewerId, entry);
    this.emitLive();

    entry.negotiationTimer = window.setTimeout(() => {
      if (
        this.peers.get(viewerId) === entry &&
        connection.connectionState !== "connected"
      ) {
        this.closePeer(viewerId);
      }
    }, PEER_NEGOTIATION_TIMEOUT_MS);

    const sender = connection.addTrack(track, this.stream!);
    void this.limitSenderBitrate(sender);

    connection.onicecandidate = (event) => {
      if (!event.candidate || !this.wanted) return;
      this.send({
        type: "ice",
        target: viewerId,
        candidate: event.candidate.toJSON(),
      });
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "connected") {
        this.clearPeerTimer(entry, "negotiationTimer");
        this.clearPeerTimer(entry, "disconnectedTimer");
        this.emitLive();
      } else if (connection.connectionState === "disconnected") {
        this.emitLive();
        if (entry.disconnectedTimer === null) {
          entry.disconnectedTimer = window.setTimeout(() => {
            if (
              this.peers.get(viewerId) === entry &&
              connection.connectionState !== "connected"
            ) {
              this.closePeer(viewerId);
            }
          }, PEER_DISCONNECTED_TIMEOUT_MS);
        }
      } else if (
        connection.connectionState === "failed" ||
        connection.connectionState === "closed"
      ) {
        this.closePeer(viewerId);
      }
    };

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (
        !this.wanted ||
        this.socket !== socket ||
        this.peers.get(viewerId)?.connection !== connection
      ) {
        this.closePeer(viewerId);
        return;
      }
      const localDescription = connection.localDescription;
      if (!localDescription?.sdp) throw new Error("Missing local offer");
      this.sendWithSocket(socket, {
        type: "offer",
        target: viewerId,
        sdp: {
          type: "offer",
          sdp: localDescription.sdp,
        },
      });
    } catch {
      this.closePeer(viewerId);
    }
  }

  private async limitSenderBitrate(sender: RTCRtpSender) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      parameters.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
      await sender.setParameters(parameters);
    } catch {
      // Some mobile browsers do not expose encoding controls. The stream
      // remains limited to a 640px canvas at 12fps.
    }
  }

  private async applyAnswer(
    viewerId: string,
    answer: RTCSessionDescriptionInit,
  ) {
    const entry = this.peers.get(viewerId);
    if (!entry) return;
    try {
      await entry.connection.setRemoteDescription(answer);
      const pending = entry.pendingCandidates.splice(0);
      for (const candidate of pending) {
        await entry.connection.addIceCandidate(candidate);
      }
    } catch {
      this.closePeer(viewerId);
    }
  }

  private async applyIce(viewerId: string, candidate: RTCIceCandidateInit) {
    const entry = this.peers.get(viewerId);
    if (!entry) return;
    if (!entry.connection.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    try {
      await entry.connection.addIceCandidate(candidate);
    } catch {
      this.closePeer(viewerId);
    }
  }

  private closePeer(viewerId: string) {
    const entry = this.peers.get(viewerId);
    if (!entry) return;
    this.peers.delete(viewerId);
    this.clearPeerTimer(entry, "negotiationTimer");
    this.clearPeerTimer(entry, "disconnectedTimer");
    entry.connection.onicecandidate = null;
    entry.connection.onconnectionstatechange = null;
    entry.connection.close();
    if (this.wanted) this.emitLive();
  }

  private closeAllPeers() {
    for (const entry of this.peers.values()) {
      this.clearPeerTimer(entry, "negotiationTimer");
      this.clearPeerTimer(entry, "disconnectedTimer");
      entry.connection.onicecandidate = null;
      entry.connection.onconnectionstatechange = null;
      entry.connection.close();
    }
    this.peers.clear();
  }

  private clearPeerTimer(
    entry: PeerEntry,
    key: "negotiationTimer" | "disconnectedTimer",
  ) {
    const timer = entry[key];
    if (timer !== null) {
      window.clearTimeout(timer);
      entry[key] = null;
    }
  }

  private send(message: Record<string, unknown>) {
    const socket = this.socket;
    if (socket) this.sendWithSocket(socket, message);
  }

  private sendWithSocket(
    socket: WebSocket,
    message: Record<string, unknown>,
  ) {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Socket close/reconnect handles delivery failure.
    }
  }

  private connectedViewerCount() {
    let connected = 0;
    for (const entry of this.peers.values()) {
      if (entry.connection.connectionState === "connected") connected += 1;
    }
    return connected;
  }

  private emitLive() {
    const viewerCount = this.connectedViewerCount();
    this.emit({
      state: "live",
      viewerCount,
      message:
        viewerCount > 0
          ? `관제 화면 ${viewerCount}곳에 익명화 영상을 공유 중입니다.`
          : "실시간 공유 중 · 관제 화면 연결 대기",
    });
  }

  private fail(message: string) {
    this.stop(false);
    this.emit({
      state: "error",
      viewerCount: 0,
      message,
    });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private markSignalingStableLater(socket: WebSocket) {
    if (this.stabilityTimer !== null) return;
    this.stabilityTimer = window.setTimeout(() => {
      this.stabilityTimer = null;
      if (
        this.wanted &&
        this.socket === socket &&
        socket.readyState === WebSocket.OPEN
      ) {
        this.reconnectAttempts = 0;
      }
    }, STABLE_SIGNALING_MS);
  }

  private clearStabilityTimer() {
    if (this.stabilityTimer !== null) {
      window.clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private emit(snapshot: LiveBroadcastSnapshot) {
    if (
      this.lastSnapshot.state === snapshot.state &&
      this.lastSnapshot.viewerCount === snapshot.viewerCount &&
      this.lastSnapshot.message === snapshot.message
    ) {
      return;
    }
    this.lastSnapshot = snapshot;
    this.onStatus(snapshot);
  }
}
