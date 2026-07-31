"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LiveViewerState = "connecting" | "live" | "offline";
export type LiveViewerTransport = "webrtc" | "relay" | null;

type SignalMessage = {
  type?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
  role?: unknown;
  peerId?: unknown;
  from?: unknown;
  broadcasterId?: unknown;
  broadcasterOnline?: unknown;
  sdp?: unknown;
  candidate?: unknown;
};

type FrameProgressTarget = {
  stream: MediaStream;
  onFrame: () => void;
};

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const MAX_RECONNECT_ATTEMPTS = 8;
const STABLE_SOCKET_MS = 30_000;
const NEGOTIATION_TIMEOUT_MS = 15_000;
const DISCONNECTED_TIMEOUT_MS = 8_000;
const RELAY_REQUEST_DELAY_MS = 5_000;
const RELAY_FRAME_STALL_MS = 4_000;
const MAX_RELAY_FRAME_BYTES = 48 * 1024;

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function sessionDescription(
  value: unknown,
  expectedType: RTCSdpType,
): RTCSessionDescriptionInit | null {
  if (!value || typeof value !== "object") return null;
  const description = value as { type?: unknown; sdp?: unknown };
  if (
    description.type !== expectedType ||
    typeof description.sdp !== "string"
  ) {
    return null;
  }
  return { type: expectedType, sdp: description.sdp };
}

function iceCandidate(value: unknown): RTCIceCandidateInit | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    candidate?: unknown;
    sdpMid?: unknown;
    sdpMLineIndex?: unknown;
    usernameFragment?: unknown;
  };
  if (typeof candidate.candidate !== "string") return null;
  return {
    candidate: candidate.candidate,
    sdpMid: typeof candidate.sdpMid === "string" ? candidate.sdpMid : null,
    sdpMLineIndex:
      typeof candidate.sdpMLineIndex === "number"
        ? candidate.sdpMLineIndex
        : null,
    usernameFragment:
      typeof candidate.usernameFragment === "string"
        ? candidate.usernameFragment
        : null,
  };
}

export function useLiveViewer(enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const frameProgressTargetRef = useRef<FrameProgressTarget | null>(null);
  const relayFrameUrlRef = useRef<string | null>(null);
  const [state, setState] = useState<LiveViewerState>("offline");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [relayFrameUrl, setRelayFrameUrl] = useState<string | null>(null);
  const [transport, setTransport] = useState<LiveViewerTransport>(null);
  const [restartToken, setRestartToken] = useState(0);

  const reconnect = useCallback(() => {
    setRestartToken((current) => current + 1);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = remoteStream;
    let cancelled = false;
    let frameCallbackId: number | null = null;
    let pollingTimer: number | null = null;
    let lastPresentedFrames = -1;
    let lastCurrentTime = video.currentTime;

    const reportFrameProgress = () => {
      const target = frameProgressTargetRef.current;
      if (!target || target.stream !== remoteStream) return;
      target.onFrame();
    };

    if (remoteStream) {
      void video.play().catch(() => undefined);
      if (typeof video.requestVideoFrameCallback === "function") {
        const watchFrame: VideoFrameRequestCallback = (_now, metadata) => {
          if (cancelled) return;
          if (metadata.presentedFrames > lastPresentedFrames) {
            lastPresentedFrames = metadata.presentedFrames;
            reportFrameProgress();
          }
          frameCallbackId = video.requestVideoFrameCallback(watchFrame);
        };
        frameCallbackId = video.requestVideoFrameCallback(watchFrame);
      } else {
        pollingTimer = window.setInterval(() => {
          if (
            cancelled ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
          ) {
            return;
          }
          const currentTime = video.currentTime;
          if (currentTime > lastCurrentTime + 0.001) {
            lastCurrentTime = currentTime;
            reportFrameProgress();
          }
        }, 500);
      }
    }
    return () => {
      cancelled = true;
      if (
        frameCallbackId !== null &&
        typeof video.cancelVideoFrameCallback === "function"
      ) {
        video.cancelVideoFrameCallback(frameCallbackId);
      }
      if (pollingTimer !== null) window.clearInterval(pollingTimer);
      if (video.srcObject === remoteStream) video.srcObject = null;
    };
  }, [remoteStream, transport]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let reconnectAllowed = true;
    let socket: WebSocket | null = null;
    let peer: RTCPeerConnection | null = null;
    let reconnectTimer: number | null = null;
    let stabilityTimer: number | null = null;
    let negotiationTimer: number | null = null;
    let disconnectedTimer: number | null = null;
    let frameStallTimer: number | null = null;
    let relayRequestTimer: number | null = null;
    let relayStallTimer: number | null = null;
    let reconnectAttempt = 0;
    let broadcasterId = "";
    let pendingCandidates: RTCIceCandidateInit[] = [];
    let relayRequested = false;
    let webrtcReady = false;

    const clearTimer = (timer: number | null) => {
      if (timer !== null) window.clearTimeout(timer);
    };

    const updateRemoteStream = (stream: MediaStream | null) => {
      remoteStreamRef.current = stream;
      if (!disposed) setRemoteStream(stream);
    };

    const clearVideo = () => {
      const stream = remoteStreamRef.current;
      stream?.getTracks().forEach((track) => {
        track.onended = null;
        track.onmute = null;
        track.onunmute = null;
        track.stop();
      });
      if (videoRef.current) videoRef.current.srcObject = null;
      updateRemoteStream(null);
    };

    const clearRelayFrame = () => {
      clearTimer(relayStallTimer);
      relayStallTimer = null;
      const previousUrl = relayFrameUrlRef.current;
      relayFrameUrlRef.current = null;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      if (!disposed) setRelayFrameUrl(null);
    };

    const clearPeerTimers = () => {
      clearTimer(stabilityTimer);
      clearTimer(negotiationTimer);
      clearTimer(disconnectedTimer);
      clearTimer(frameStallTimer);
      stabilityTimer = null;
      negotiationTimer = null;
      disconnectedTimer = null;
      frameStallTimer = null;
    };

    const closePeer = (nextState?: LiveViewerState) => {
      clearPeerTimers();
      webrtcReady = false;
      frameProgressTargetRef.current = null;
      if (peer) {
        peer.onicecandidate = null;
        peer.ontrack = null;
        peer.onconnectionstatechange = null;
        peer.close();
        peer = null;
      }
      pendingCandidates = [];
      clearVideo();
      if (!disposed && nextState) {
        if (relayFrameUrlRef.current) {
          setTransport("relay");
          setState("live");
        } else {
          setTransport(null);
          setState(nextState);
        }
      }
    };

    const send = (message: Record<string, unknown>) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify(message));
      } catch {
        socket.close();
      }
    };

    const stopRelayFallback = () => {
      clearTimer(relayRequestTimer);
      relayRequestTimer = null;
      if (relayRequested) send({ type: "relay-stop" });
      relayRequested = false;
      clearRelayFrame();
    };

    const requestRelayFallback = () => {
      if (disposed || socket?.readyState !== WebSocket.OPEN) return;
      clearTimer(relayRequestTimer);
      relayRequestTimer = null;
      if (!relayRequested) {
        relayRequested = true;
        send({ type: "relay-request" });
      }
      if (relayFrameUrlRef.current) {
        setTransport("relay");
        setState("live");
      } else {
        setState("connecting");
      }
    };

    const handleRelayFrame = (buffer: ArrayBuffer) => {
      const bytes = new Uint8Array(buffer);
      if (
        buffer.byteLength < 4 ||
        buffer.byteLength > MAX_RELAY_FRAME_BYTES ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff ||
        bytes[bytes.length - 2] !== 0xff ||
        bytes[bytes.length - 1] !== 0xd9 ||
        webrtcReady
      ) {
        return;
      }

      const nextUrl = URL.createObjectURL(
        new Blob([buffer], { type: "image/jpeg" }),
      );
      const previousUrl = relayFrameUrlRef.current;
      relayFrameUrlRef.current = nextUrl;
      setRelayFrameUrl(nextUrl);
      setTransport("relay");
      setState("live");
      reconnectAttempt = 0;
      send({ type: "relay-ack" });
      if (previousUrl) URL.revokeObjectURL(previousUrl);

      clearTimer(relayStallTimer);
      relayStallTimer = window.setTimeout(() => {
        relayStallTimer = null;
        if (disposed || relayFrameUrlRef.current !== nextUrl || webrtcReady) {
          return;
        }
        clearRelayFrame();
        setTransport(null);
        setState("connecting");
        if (relayRequested) {
          send({ type: "relay-stop" });
          relayRequested = false;
        }
        requestRelayFallback();
      }, RELAY_FRAME_STALL_MS);
    };

    const handleOffer = async (message: SignalMessage) => {
      const offer = sessionDescription(message.sdp, "offer");
      const target =
        stringValue(message.from) ||
        stringValue(message.broadcasterId) ||
        broadcasterId;
      if (!offer || !target || disposed) return;

      broadcasterId = target;
      if (typeof RTCPeerConnection === "undefined") {
        requestRelayFallback();
        return;
      }
      const queuedCandidates = pendingCandidates;
      closePeer(relayFrameUrlRef.current ? "live" : "connecting");
      pendingCandidates = [];

      let nextPeer: RTCPeerConnection;
      try {
        nextPeer = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        });
      } catch {
        requestRelayFallback();
        return;
      }
      peer = nextPeer;
      let peerWasLive = false;
      let decodedFrameSeen = false;
      let lastDecodedFrameAt = 0;

      const reconnectPeer = (reason: string) => {
        if (disposed || peer !== nextPeer) return;
        closePeer(relayFrameUrlRef.current ? "live" : "connecting");
        requestRelayFallback();
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          socket?.close(4000, reason);
        }
      };

      const startDisconnectedWatchdog = () => {
        clearTimer(disconnectedTimer);
        disconnectedTimer = window.setTimeout(() => {
          disconnectedTimer = null;
          reconnectPeer("media timeout");
        }, DISCONNECTED_TIMEOUT_MS);
      };

      const scheduleFrameStallCheck = () => {
        if (frameStallTimer !== null) return;
        const checkProgress = () => {
          frameStallTimer = null;
          if (disposed || peer !== nextPeer || !peerWasLive) return;
          const remaining =
            DISCONNECTED_TIMEOUT_MS - (Date.now() - lastDecodedFrameAt);
          if (remaining <= 0) {
            reconnectPeer("video frame timeout");
            return;
          }
          frameStallTimer = window.setTimeout(
            checkProgress,
            Math.max(250, remaining),
          );
        };
        const initialRemaining =
          DISCONNECTED_TIMEOUT_MS - (Date.now() - lastDecodedFrameAt);
        frameStallTimer = window.setTimeout(
          checkProgress,
          Math.max(250, initialRemaining),
        );
      };

      const markLiveIfReady = () => {
        if (
          disposed ||
          peer !== nextPeer ||
          nextPeer.connectionState !== "connected" ||
          !decodedFrameSeen ||
          Date.now() - lastDecodedFrameAt >= DISCONNECTED_TIMEOUT_MS
        ) {
          return false;
        }
        const liveVideoTrack = remoteStreamRef.current
          ?.getVideoTracks()
          .find((track) => track.readyState === "live" && !track.muted);
        if (!liveVideoTrack) return false;

        const firstConnectedFrame = !peerWasLive;
        peerWasLive = true;
        webrtcReady = true;
        clearTimer(negotiationTimer);
        clearTimer(disconnectedTimer);
        negotiationTimer = null;
        disconnectedTimer = null;
        scheduleFrameStallCheck();
        if (firstConnectedFrame) {
          // Reset the retry budget only after media—not merely the signaling
          // socket—has remained healthy for a sustained period.
          stabilityTimer = window.setTimeout(() => {
            stabilityTimer = null;
            if (
              !disposed &&
              peer === nextPeer &&
              nextPeer.connectionState === "connected"
            ) {
              reconnectAttempt = 0;
            }
          }, STABLE_SOCKET_MS);
        }
        stopRelayFallback();
        setTransport("webrtc");
        setState("live");
        return true;
      };

      const handleDecodedFrame = () => {
        if (disposed || peer !== nextPeer) return;
        decodedFrameSeen = true;
        lastDecodedFrameAt = Date.now();
        if (!markLiveIfReady()) setState("connecting");
      };

      negotiationTimer = window.setTimeout(() => {
        negotiationTimer = null;
        if (!markLiveIfReady()) requestRelayFallback();
      }, NEGOTIATION_TIMEOUT_MS);

      nextPeer.onicecandidate = (event) => {
        if (!event.candidate) return;
        send({
          type: "ice",
          target: broadcasterId,
          candidate: event.candidate.toJSON(),
        });
      };

      nextPeer.ontrack = (event) => {
        if (disposed || peer !== nextPeer) return;
        const stream =
          event.streams[0] ??
          new MediaStream(nextPeer.getReceivers().flatMap((receiver) =>
            receiver.track ? [receiver.track] : [],
          ));
        frameProgressTargetRef.current = {
          stream,
          onFrame: handleDecodedFrame,
        };
        updateRemoteStream(stream);
        if (event.track.kind === "video") {
          event.track.onended = () => reconnectPeer("video ended");
          event.track.onmute = () => {
            if (disposed || peer !== nextPeer) return;
            setState("connecting");
            if (peerWasLive) startDisconnectedWatchdog();
          };
          event.track.onunmute = () => {
            if (!markLiveIfReady()) setState("connecting");
          };
        }
        if (!markLiveIfReady()) setState("connecting");
      };

      nextPeer.onconnectionstatechange = () => {
        if (disposed || peer !== nextPeer) return;
        if (nextPeer.connectionState === "connected") {
          if (!markLiveIfReady()) {
            setState("connecting");
            if (peerWasLive) startDisconnectedWatchdog();
          }
        } else if (
          nextPeer.connectionState === "failed" ||
          nextPeer.connectionState === "closed"
        ) {
          reconnectPeer("peer retry");
        } else if (nextPeer.connectionState === "disconnected") {
          setState("connecting");
          startDisconnectedWatchdog();
        }
      };

      try {
        await nextPeer.setRemoteDescription(offer);
        if (disposed || peer !== nextPeer) return;
        const candidatesToAdd = [
          ...queuedCandidates,
          ...pendingCandidates,
        ];
        pendingCandidates = [];
        for (const candidate of candidatesToAdd) {
          await nextPeer.addIceCandidate(candidate);
        }
        const answer = await nextPeer.createAnswer();
        await nextPeer.setLocalDescription(answer);
        if (disposed || peer !== nextPeer || !nextPeer.localDescription) return;
        send({
          type: "answer",
          target: broadcasterId,
          sdp: nextPeer.localDescription.toJSON(),
        });
      } catch {
        if (peer === nextPeer) {
          closePeer(relayFrameUrlRef.current ? "live" : "connecting");
          requestRelayFallback();
        }
      }
    };

    const handleMessage = async (data: unknown) => {
      if (data instanceof ArrayBuffer) {
        handleRelayFrame(data);
        return;
      }
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        handleRelayFrame(await data.arrayBuffer());
        return;
      }
      if (typeof data !== "string") return;
      let message: SignalMessage;
      try {
        message = JSON.parse(data) as SignalMessage;
      } catch {
        return;
      }

      const type = stringValue(message.type);
      if (type === "offer") {
        await handleOffer(message);
        return;
      }

      if (type === "ice") {
        const candidate = iceCandidate(message.candidate);
        if (!candidate) return;
        const source = stringValue(message.from);
        if (source) broadcasterId = source;
        if (!peer || !peer.remoteDescription) {
          pendingCandidates.push(candidate);
          return;
        }
        await peer.addIceCandidate(candidate).catch(() => undefined);
        return;
      }

      if (type === "peer-left" && message.role === "broadcaster") {
        broadcasterId = "";
        relayRequested = false;
        clearTimer(relayRequestTimer);
        relayRequestTimer = null;
        clearRelayFrame();
        closePeer("offline");
        return;
      }

      if (type === "error") {
        closePeer("offline");
        socket?.close(4001, "signal retry");
        return;
      }

      if (type !== "status") return;
      const status = stringValue(message.status);
      if (status === "error") {
        const code = stringValue(message.code);
        if (
          code === "AUTH_REQUIRED" ||
          code === "SESSION_EXPIRED" ||
          code === "VIEWER_LIMIT_REACHED"
        ) {
          reconnectAllowed = false;
        }
        closePeer("offline");
        socket?.close(4001, "signal error");
        return;
      }
      const statusBroadcasterId = stringValue(message.broadcasterId);
      if (statusBroadcasterId) broadcasterId = statusBroadcasterId;

      if (status === "joined" || status === "room-state") {
        const isOnline =
          typeof message.broadcasterOnline === "boolean"
            ? message.broadcasterOnline
            : Boolean(broadcasterId);
        if (!isOnline) {
          broadcasterId = "";
          relayRequested = false;
          clearTimer(relayRequestTimer);
          relayRequestTimer = null;
          clearRelayFrame();
          closePeer("offline");
        } else if (
          !remoteStreamRef.current &&
          !relayFrameUrlRef.current
        ) {
          setState("connecting");
          if (typeof RTCPeerConnection === "undefined") {
            requestRelayFallback();
          } else if (
            !relayRequested &&
            relayRequestTimer === null
          ) {
            relayRequestTimer = window.setTimeout(
              requestRelayFallback,
              RELAY_REQUEST_DELAY_MS,
            );
          }
        }
      }
    };

    const scheduleReconnect = () => {
      if (!reconnectAllowed || disposed || reconnectTimer !== null) return;
      if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        setState("offline");
        return;
      }
      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
        ];
      reconnectAttempt += 1;
      setState("connecting");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (!reconnectAllowed || disposed) return;
      clearTimer(stabilityTimer);
      stabilityTimer = null;
      closePeer("connecting");
      relayRequested = false;
      clearTimer(relayRequestTimer);
      relayRequestTimer = null;
      clearRelayFrame();
      setTransport(null);

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(
          `${protocol}//${window.location.host}/api/live/socket`,
        );
      } catch {
        scheduleReconnect();
        return;
      }
      socket = nextSocket;
      nextSocket.binaryType = "arraybuffer";

      nextSocket.onopen = () => {
        if (disposed || socket !== nextSocket) return;
        send({ type: "join", role: "viewer" });
      };

      nextSocket.onmessage = (event) => {
        if (disposed || socket !== nextSocket) return;
        void handleMessage(event.data);
      };

      nextSocket.onerror = () => {
        if (socket === nextSocket) nextSocket.close();
      };

      nextSocket.onclose = (event) => {
        if (socket !== nextSocket) return;
        socket = null;
        clearTimer(stabilityTimer);
        stabilityTimer = null;
        relayRequested = false;
        clearTimer(relayRequestTimer);
        relayRequestTimer = null;
        clearRelayFrame();
        closePeer("offline");
        if (event.code !== 4401) scheduleReconnect();
      };
    };

    if (typeof WebSocket === "undefined") {
      return;
    }

    connect();

    return () => {
      disposed = true;
      clearTimer(reconnectTimer);
      clearTimer(stabilityTimer);
      clearTimer(relayRequestTimer);
      clearTimer(relayStallTimer);
      clearPeerTimers();
      reconnectTimer = null;
      stabilityTimer = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "viewer closed");
        socket = null;
      }
      pendingCandidates = [];
      relayRequested = false;
      relayRequestTimer = null;
      clearRelayFrame();
      closePeer();
    };
  }, [enabled, restartToken]);

  return {
    videoRef,
    state: enabled ? state : "offline",
    hasStream:
      enabled &&
      state !== "offline" &&
      (remoteStream !== null || relayFrameUrl !== null),
    isLive:
      enabled &&
      state === "live" &&
      (remoteStream !== null || relayFrameUrl !== null),
    transport: enabled ? transport : null,
    relayFrameUrl: enabled ? relayFrameUrl : null,
    reconnect,
  };
}
