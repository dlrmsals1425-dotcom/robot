import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

const origin = "https://safebot.example";

async function loadWorkerModule() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "live-signaling-test",
    `${process.pid}-${Date.now()}`,
  );
  return import(workerUrl.href);
}

function createContext() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

class FakeWebSocket {
  constructor(attachment) {
    this.attachment = structuredClone(attachment);
    this.readyState = 1;
    this.messages = [];
    this.binaryMessages = [];
    this.closeCode = null;
    this.closeReason = null;
  }

  deserializeAttachment() {
    return structuredClone(this.attachment);
  }

  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }

  send(value) {
    if (typeof value === "string") {
      this.messages.push(JSON.parse(value));
      return;
    }
    assert.ok(value instanceof ArrayBuffer);
    this.binaryMessages.push(value.slice(0));
  }

  close(code, reason) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }
}

class FakeDurableObjectState {
  constructor(sockets = []) {
    this.sockets = sockets;
    this.storage = {
      alarm: null,
      setAlarm: async (scheduledTime) => {
        this.storage.alarm =
          scheduledTime instanceof Date
            ? scheduledTime.getTime()
            : scheduledTime;
      },
      deleteAlarm: async () => {
        this.storage.alarm = null;
      },
    };
  }

  getWebSockets() {
    return this.sockets;
  }

  acceptWebSocket(socket) {
    this.sockets.push(socket);
  }
}

function attachment(
  index,
  role = "pending",
  joinedAt = Date.now(),
  sessionExpiresAt = Date.now() + 60 * 60 * 1000,
) {
  return {
    peerId: `live-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    role,
    joinedAt,
    sessionExpiresAt,
    rateWindowStartedAt: Date.now(),
    rateWindowMessages: 0,
    relayRequested: false,
    relayAwaitingAck: false,
    relayAcknowledged: false,
    lastRelayFrameAt: 0,
  };
}

function socket(
  index,
  role = "pending",
  joinedAt = Date.now(),
  sessionExpiresAt = Date.now() + 60 * 60 * 1000,
) {
  return new FakeWebSocket(
    attachment(index, role, joinedAt, sessionExpiresAt),
  );
}

function signal(value) {
  return JSON.stringify(value);
}

function jpegFrame(
  size = 64,
  width = 320,
  height = 180,
  includeExif = false,
) {
  const frame = new Uint8Array(Math.max(32, size));
  frame.set([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
  let nextMarker = 21;
  if (includeExif) {
    frame.set([0xff, 0xe1, 0x00, 0x04, 0x00, 0x00], nextMarker);
    nextMarker += 6;
  }
  frame.set(
    [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00],
    nextMarker,
  );
  for (let index = nextMarker + 10; index < frame.length; index += 1) {
    frame[index] = index % 251;
  }
  frame[frame.length - 2] = 0xff;
  frame[frame.length - 1] = 0xd9;
  return frame.buffer;
}

function messagesOfType(webSocket, type) {
  return webSocket.messages.filter((message) => message.type === type);
}

function signedSessionCookie(secret, expiresAt) {
  const claims = {
    v: 1,
    iat: expiresAt - 60 * 60,
    exp: expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signedValue = `v1.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(signedValue)
    .digest("base64url");
  return `__Host-safebot_session=${signedValue}.${signature}`;
}

test("live WebSocket upgrade rejects an unauthenticated session before Durable Object access", async () => {
  const { default: worker } = await loadWorkerModule();
  let durableObjectAccessed = false;
  const env = {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    DB: {},
    CONTROL_PASSWORD: "test-control-password",
    SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    LIVE_ROOM: {
      idFromName() {
        durableObjectAccessed = true;
        return {};
      },
      get() {
        throw new Error("should not be called");
      },
    },
  };

  const response = await worker.fetch(
    new Request(`${origin}/api/live/socket`, {
      headers: { origin, upgrade: "websocket" },
    }),
    env,
    createContext(),
  );

  assert.equal(response.status, 401);
  assert.equal(durableObjectAccessed, false);
  assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
});

test("authenticated upgrade overwrites the trusted expiry header and strips the cookie", async () => {
  const { default: worker } = await loadWorkerModule();
  const sessionSecret = "test-session-secret-with-at-least-32-characters";
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
  let forwardedExpiry = null;
  let forwardedCookie = "not-called";
  const env = {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    DB: {},
    CONTROL_PASSWORD: "test-control-password",
    SESSION_SECRET: sessionSecret,
    LIVE_ROOM: {
      idFromName(name) {
        assert.equal(name, "safebot-main-room");
        return { name };
      },
      get() {
        return {
          async fetch(request) {
            forwardedExpiry = request.headers.get(
              "X-Safebot-Session-Expires-At",
            );
            forwardedCookie = request.headers.get("Cookie");
            return new Response(null, { status: 204 });
          },
        };
      },
    },
  };

  const response = await worker.fetch(
    new Request(`${origin}/api/live/socket`, {
      headers: {
        cookie: signedSessionCookie(sessionSecret, expiresAt),
        origin,
        upgrade: "websocket",
        "X-Safebot-Session-Expires-At": "9999999999999",
      },
    }),
    env,
    createContext(),
  );

  assert.equal(response.status, 204);
  assert.equal(forwardedExpiry, String(expiresAt * 1000));
  assert.equal(forwardedCookie, null);
});

test("live room rejects oversized, unknown, and invalid-role text messages", async () => {
  const { LiveRoom } = await loadWorkerModule();

  const oversizedSocket = socket(2);
  await new LiveRoom(
    new FakeDurableObjectState([oversizedSocket]),
    {},
  ).webSocketMessage(
    oversizedSocket,
    signal({ type: "status", state: "x".repeat(70_000) }),
  );
  assert.equal(oversizedSocket.closeCode, 1009);
  assert.equal(oversizedSocket.messages.at(-1).code, "SIGNAL_TOO_LARGE");

  const invalidRoleSocket = socket(3);
  await new LiveRoom(
    new FakeDurableObjectState([invalidRoleSocket]),
    {},
  ).webSocketMessage(
    invalidRoleSocket,
    signal({ type: "join", role: "administrator" }),
  );
  assert.equal(invalidRoleSocket.closeCode, 1008);
  assert.equal(invalidRoleSocket.messages.at(-1).code, "INVALID_SIGNAL");

  const extraFieldSocket = socket(4);
  await new LiveRoom(
    new FakeDurableObjectState([extraFieldSocket]),
    {},
  ).webSocketMessage(
    extraFieldSocket,
    signal({ type: "join", role: "viewer", injected: true }),
  );
  assert.equal(extraFieldSocket.closeCode, 1008);
  assert.equal(extraFieldSocket.messages.at(-1).code, "INVALID_SIGNAL");
});

test("fallback relay forwards requested JPEG frames only and honors relay stop", async () => {
  const { LiveRoom } = await loadWorkerModule();
  const subscribedViewer = socket(60, "viewer");
  const unsubscribedViewer = socket(61, "viewer");
  const broadcaster = socket(62);
  const state = new FakeDurableObjectState([
    subscribedViewer,
    unsubscribedViewer,
    broadcaster,
  ]);
  const room = new LiveRoom(state, {});

  await room.webSocketMessage(
    subscribedViewer,
    signal({ type: "relay-request" }),
  );
  assert.equal(subscribedViewer.attachment.relayRequested, true);
  assert.equal(unsubscribedViewer.attachment.relayRequested, false);

  await room.webSocketMessage(
    broadcaster,
    signal({ type: "join", role: "broadcaster" }),
  );
  assert.deepEqual(messagesOfType(broadcaster, "relay-request").at(-1), {
    type: "relay-request",
    from: subscribedViewer.attachment.peerId,
  });

  const firstFrame = jpegFrame();
  await room.webSocketMessage(broadcaster, firstFrame);
  assert.equal(subscribedViewer.binaryMessages.length, 1);
  assert.equal(subscribedViewer.attachment.relayAwaitingAck, true);
  assert.deepEqual(
    new Uint8Array(subscribedViewer.binaryMessages[0]),
    new Uint8Array(firstFrame),
  );
  assert.equal(unsubscribedViewer.binaryMessages.length, 0);

  broadcaster.attachment.lastRelayFrameAt = Date.now() - 901;
  await room.webSocketMessage(broadcaster, jpegFrame());
  assert.equal(
    subscribedViewer.binaryMessages.length,
    1,
    "a slow viewer receives at most one unacknowledged frame",
  );

  await room.webSocketMessage(
    subscribedViewer,
    signal({ type: "relay-ack" }),
  );
  assert.equal(subscribedViewer.attachment.relayAwaitingAck, false);
  assert.equal(subscribedViewer.attachment.relayAcknowledged, true);
  assert.deepEqual(messagesOfType(broadcaster, "relay-live").at(-1), {
    type: "relay-live",
    from: subscribedViewer.attachment.peerId,
  });

  broadcaster.attachment.lastRelayFrameAt = Date.now() - 901;
  await room.webSocketMessage(broadcaster, jpegFrame());
  assert.equal(subscribedViewer.binaryMessages.length, 2);

  await room.webSocketMessage(
    subscribedViewer,
    signal({ type: "relay-stop" }),
  );
  assert.equal(subscribedViewer.attachment.relayRequested, false);
  assert.equal(subscribedViewer.attachment.relayAwaitingAck, false);
  assert.equal(subscribedViewer.attachment.relayAcknowledged, false);
  assert.deepEqual(messagesOfType(broadcaster, "relay-stop").at(-1), {
    type: "relay-stop",
    from: subscribedViewer.attachment.peerId,
  });

  broadcaster.attachment.lastRelayFrameAt = Date.now() - 901;
  await room.webSocketMessage(broadcaster, jpegFrame());
  assert.equal(subscribedViewer.binaryMessages.length, 2);
  assert.equal(unsubscribedViewer.binaryMessages.length, 0);
});

test("fallback relay rejects invalid roles and frames while dropping network bursts", async () => {
  const { LiveRoom } = await loadWorkerModule();

  const oversized = socket(70, "broadcaster");
  await new LiveRoom(
    new FakeDurableObjectState([oversized]),
    {},
  ).webSocketMessage(oversized, jpegFrame(48 * 1024 + 1));
  assert.equal(oversized.closeCode, 1009);
  assert.equal(oversized.messages.at(-1).code, "RELAY_FRAME_TOO_LARGE");

  const malformed = socket(71, "broadcaster");
  await new LiveRoom(
    new FakeDurableObjectState([malformed]),
    {},
  ).webSocketMessage(malformed, new Uint8Array([0, 1, 2, 3]).buffer);
  assert.equal(malformed.closeCode, 1008);
  assert.equal(malformed.messages.at(-1).code, "INVALID_RELAY_FRAME");

  const oversizedDimensions = socket(75, "broadcaster");
  await new LiveRoom(
    new FakeDurableObjectState([oversizedDimensions]),
    {},
  ).webSocketMessage(
    oversizedDimensions,
    jpegFrame(64, 321, 180),
  );
  assert.equal(oversizedDimensions.closeCode, 1008);
  assert.equal(
    oversizedDimensions.messages.at(-1).code,
    "INVALID_RELAY_DIMENSIONS",
  );

  const embeddedExif = socket(76, "broadcaster");
  await new LiveRoom(
    new FakeDurableObjectState([embeddedExif]),
    {},
  ).webSocketMessage(
    embeddedExif,
    jpegFrame(80, 320, 180, true),
  );
  assert.equal(embeddedExif.closeCode, 1008);
  assert.equal(
    embeddedExif.messages.at(-1).code,
    "INVALID_RELAY_DIMENSIONS",
  );

  const tooFast = socket(72, "broadcaster");
  tooFast.attachment.lastRelayFrameAt = Date.now();
  await new LiveRoom(
    new FakeDurableObjectState([tooFast]),
    {},
  ).webSocketMessage(tooFast, jpegFrame());
  assert.equal(tooFast.closeCode, null);
  assert.equal(tooFast.binaryMessages.length, 0);

  const viewer = socket(73, "viewer");
  await new LiveRoom(
    new FakeDurableObjectState([viewer]),
    {},
  ).webSocketMessage(viewer, jpegFrame());
  assert.equal(viewer.closeCode, 1008);
  assert.equal(viewer.messages.at(-1).code, "ROLE_NOT_ALLOWED");

  const pending = socket(74);
  await new LiveRoom(
    new FakeDurableObjectState([pending]),
    {},
  ).webSocketMessage(pending, jpegFrame());
  assert.equal(pending.closeCode, 1008);
  assert.equal(pending.messages.at(-1).code, "JOIN_REQUIRED");
});

test("fallback relay control is viewer-only and shares the combined abuse limit", async () => {
  const { LiveRoom } = await loadWorkerModule();

  const broadcasterControl = socket(80, "broadcaster");
  await new LiveRoom(
    new FakeDurableObjectState([broadcasterControl]),
    {},
  ).webSocketMessage(broadcasterControl, signal({ type: "relay-request" }));
  assert.equal(broadcasterControl.closeCode, 1008);
  assert.equal(broadcasterControl.messages.at(-1).code, "ROLE_NOT_ALLOWED");

  const extraField = socket(81, "viewer");
  await new LiveRoom(
    new FakeDurableObjectState([extraField]),
    {},
  ).webSocketMessage(
    extraField,
    signal({ type: "relay-request", injected: true }),
  );
  assert.equal(extraField.closeCode, 1008);
  assert.equal(extraField.messages.at(-1).code, "INVALID_SIGNAL");

  const ackWithoutRelay = socket(83, "viewer");
  await new LiveRoom(
    new FakeDurableObjectState([ackWithoutRelay]),
    {},
  ).webSocketMessage(ackWithoutRelay, signal({ type: "relay-ack" }));
  assert.equal(ackWithoutRelay.closeCode, 1008);
  assert.equal(ackWithoutRelay.messages.at(-1).code, "RELAY_NOT_REQUESTED");

  const ackWithoutFrame = socket(84, "viewer");
  const ackWithoutFrameRoom = new LiveRoom(
    new FakeDurableObjectState([ackWithoutFrame]),
    {},
  );
  await ackWithoutFrameRoom.webSocketMessage(
    ackWithoutFrame,
    signal({ type: "relay-request" }),
  );
  await ackWithoutFrameRoom.webSocketMessage(
    ackWithoutFrame,
    signal({ type: "relay-ack" }),
  );
  assert.equal(ackWithoutFrame.closeCode, 1008);
  assert.equal(
    ackWithoutFrame.messages.at(-1).code,
    "RELAY_ACK_NOT_PENDING",
  );

  const combinedLimit = socket(82, "broadcaster");
  combinedLimit.attachment.rateWindowMessages = 240;
  await new LiveRoom(
    new FakeDurableObjectState([combinedLimit]),
    {},
  ).webSocketMessage(combinedLimit, jpegFrame());
  assert.equal(combinedLimit.closeCode, 1008);
  assert.equal(combinedLimit.messages.at(-1).code, "SIGNAL_RATE_LIMIT");
});

test("broadcaster departure clears relay state before a replacement joins", async () => {
  const { LiveRoom } = await loadWorkerModule();
  const broadcaster = socket(90, "broadcaster");
  const viewer = socket(91, "viewer");
  viewer.attachment.relayRequested = true;
  viewer.attachment.relayAwaitingAck = true;
  viewer.attachment.relayAcknowledged = true;
  const replacement = socket(92);
  const state = new FakeDurableObjectState([
    broadcaster,
    viewer,
    replacement,
  ]);
  const room = new LiveRoom(state, {});

  await room.webSocketClose(broadcaster, 1000, "done");
  assert.equal(viewer.attachment.relayRequested, false);
  assert.equal(viewer.attachment.relayAwaitingAck, false);
  assert.equal(viewer.attachment.relayAcknowledged, false);

  await room.webSocketMessage(
    replacement,
    signal({ type: "join", role: "broadcaster" }),
  );
  assert.equal(messagesOfType(replacement, "relay-request").length, 0);
});

test("expired sessions are rejected per message and idle sockets close on the next alarm", async () => {
  const { LiveRoom } = await loadWorkerModule();
  const futureExpiry = Date.now() + 30 * 60 * 1000;
  const expiredOnMessage = socket(
    5,
    "broadcaster",
    Date.now() - 1000,
    Date.now() - 1,
  );
  const activeViewer = socket(6, "viewer", Date.now(), futureExpiry);
  const messageState = new FakeDurableObjectState([
    expiredOnMessage,
    activeViewer,
  ]);
  const messageRoom = new LiveRoom(messageState, {});

  await messageRoom.webSocketMessage(
    expiredOnMessage,
    signal({ type: "status", state: "live" }),
  );

  assert.equal(expiredOnMessage.closeCode, 4401);
  assert.deepEqual(expiredOnMessage.messages.at(-1), {
    type: "status",
    status: "error",
    code: "SESSION_EXPIRED",
    message: "관제 인증이 만료되었습니다.",
  });
  assert.equal(activeViewer.messages.length, 0);
  assert.equal(messageState.storage.alarm, futureExpiry);

  const expiredWhileIdle = socket(
    7,
    "viewer",
    Date.now() - 1000,
    Date.now() - 1,
  );
  const laterExpiry = Date.now() + 45 * 60 * 1000;
  const activeBroadcaster = socket(
    8,
    "broadcaster",
    Date.now(),
    laterExpiry,
  );
  const alarmState = new FakeDurableObjectState([
    expiredWhileIdle,
    activeBroadcaster,
  ]);
  const alarmRoom = new LiveRoom(alarmState, {});

  await alarmRoom.alarm();

  assert.equal(expiredWhileIdle.closeCode, 4401);
  assert.equal(expiredWhileIdle.messages.at(-1).code, "SESSION_EXPIRED");
  assert.equal(activeBroadcaster.readyState, 1);
  assert.equal(alarmState.storage.alarm, laterExpiry);
});

test("viewer-first join, SDP, ICE, status, and peer-left route only to intended peers", async () => {
  const { LiveRoom } = await loadWorkerModule();
  const viewer = socket(10);
  const broadcaster = socket(20);
  const state = new FakeDurableObjectState([viewer, broadcaster]);
  const room = new LiveRoom(state, {});

  await room.webSocketMessage(
    viewer,
    signal({ type: "join", role: "viewer" }),
  );
  assert.equal(viewer.attachment.role, "viewer");
  assert.equal(
    messagesOfType(viewer, "status").at(-1).broadcasterOnline,
    false,
  );

  await room.webSocketMessage(
    broadcaster,
    signal({ type: "join", role: "broadcaster" }),
  );
  assert.equal(broadcaster.attachment.role, "broadcaster");
  assert.deepEqual(messagesOfType(broadcaster, "viewer-joined").at(-1), {
    type: "viewer-joined",
    viewerId: viewer.attachment.peerId,
  });
  assert.equal(
    messagesOfType(viewer, "status").at(-1).broadcasterOnline,
    true,
  );

  const offerSdp = "v=0\r\na=group:BUNDLE 0\r\n";
  await room.webSocketMessage(
    broadcaster,
    signal({
      type: "offer",
      target: viewer.attachment.peerId,
      sdp: { type: "offer", sdp: offerSdp },
    }),
  );
  assert.deepEqual(messagesOfType(viewer, "offer").at(-1), {
    type: "offer",
    from: broadcaster.attachment.peerId,
    sdp: { type: "offer", sdp: offerSdp },
  });

  const answerSdp = "v=0\r\na=recvonly\r\n";
  await room.webSocketMessage(
    viewer,
    signal({
      type: "answer",
      target: broadcaster.attachment.peerId,
      sdp: { type: "answer", sdp: answerSdp },
    }),
  );
  assert.deepEqual(messagesOfType(broadcaster, "answer").at(-1), {
    type: "answer",
    from: viewer.attachment.peerId,
    sdp: { type: "answer", sdp: answerSdp },
  });

  const candidate = {
    candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "abc",
  };
  await room.webSocketMessage(
    viewer,
    signal({
      type: "ice",
      target: broadcaster.attachment.peerId,
      candidate,
    }),
  );
  assert.deepEqual(messagesOfType(broadcaster, "ice").at(-1), {
    type: "ice",
    from: viewer.attachment.peerId,
    candidate,
  });

  await room.webSocketMessage(
    broadcaster,
    signal({ type: "status", state: "live" }),
  );
  assert.deepEqual(messagesOfType(viewer, "status").at(-1), {
    type: "status",
    status: "peer-state",
    peerId: broadcaster.attachment.peerId,
    role: "broadcaster",
    state: "live",
  });

  viewer.readyState = 3;
  await room.webSocketClose(viewer, 1000, "done", true);
  assert.deepEqual(messagesOfType(broadcaster, "peer-left").at(-1), {
    type: "peer-left",
    peerId: viewer.attachment.peerId,
    role: "viewer",
  });
  assert.equal(
    messagesOfType(broadcaster, "status").at(-1).viewerCount,
    0,
  );
});

test("room enforces one broadcaster and three viewers without closing peers on stale targets", async () => {
  const { LiveRoom } = await loadWorkerModule();

  const broadcaster = socket(30, "broadcaster");
  const secondBroadcaster = socket(31);
  const broadcasterState = new FakeDurableObjectState([
    broadcaster,
    secondBroadcaster,
  ]);
  await new LiveRoom(broadcasterState, {}).webSocketMessage(
    secondBroadcaster,
    signal({ type: "join", role: "broadcaster" }),
  );
  assert.equal(secondBroadcaster.closeCode, 1008);
  assert.equal(
    secondBroadcaster.messages.at(-1).code,
    "BROADCASTER_ALREADY_CONNECTED",
  );

  const viewers = [
    socket(40, "viewer"),
    socket(41, "viewer"),
    socket(42, "viewer"),
  ];
  const fourthViewer = socket(43);
  const viewerState = new FakeDurableObjectState([...viewers, fourthViewer]);
  await new LiveRoom(viewerState, {}).webSocketMessage(
    fourthViewer,
    signal({ type: "join", role: "viewer" }),
  );
  assert.equal(fourthViewer.closeCode, 1008);
  assert.equal(fourthViewer.messages.at(-1).code, "VIEWER_LIMIT_REACHED");

  const broadcasterRoom = new LiveRoom(
    new FakeDurableObjectState([broadcaster, viewers[0]]),
    {},
  );
  const missingPeerId = attachment(99).peerId;
  await broadcasterRoom.webSocketMessage(
    broadcaster,
    signal({
      type: "offer",
      target: missingPeerId,
      sdp: { type: "offer", sdp: "v=0\r\n" },
    }),
  );
  assert.equal(broadcaster.readyState, 1);
  assert.deepEqual(messagesOfType(broadcaster, "error").at(-1), {
    type: "error",
    code: "TARGET_NOT_FOUND",
    message: "연결할 관제 화면을 찾을 수 없습니다.",
    peerId: missingPeerId,
  });
});

test("room admission drops stale pending sockets before applying the connection cap", async () => {
  const { LiveRoom } = await loadWorkerModule();
  const stale = socket(50, "pending", Date.now() - 20_000);
  const active = [
    socket(51, "broadcaster"),
    socket(52, "viewer"),
    socket(53, "viewer"),
    socket(54, "viewer"),
  ];
  const state = new FakeDurableObjectState([stale, ...active]);
  const room = new LiveRoom(state, {});

  // The stale pending peer is closed, then the four joined peers still fill the room.
  const fullResponse = await room.fetch(
    new Request(`${origin}/socket`, {
      headers: {
        upgrade: "websocket",
        "X-Safebot-Session-Expires-At": String(
          Date.now() + 60 * 60 * 1000,
        ),
      },
    }),
  );
  assert.equal(stale.closeCode, 1008);
  assert.equal(fullResponse.status, 429);
  assert.equal((await fullResponse.json()).error.code, "LIVE_ROOM_CONNECTION_LIMIT");
});
