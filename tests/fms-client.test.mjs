import assert from "node:assert/strict";
import test from "node:test";

import {
  FMS_API_BASE_URL,
  FMS_LIVEKIT_URL,
  FmsClient,
  FmsClientError,
  normalizeFmsRobotRoomName,
} from "../app/fms-client.ts";

const EXAMPLE_EMAIL = "operator@example.test";
const EXAMPLE_PASSWORD = "not-a-real-password";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordedFetch(responses) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected test request");
    return response;
  };
  return { calls, fetchImpl };
}

async function authenticate(client) {
  await client.login({ email: EXAMPLE_EMAIL, password: EXAMPLE_PASSWORD });
}

test("exports the confirmed FMS API and LiveKit endpoints", () => {
  assert.equal(FMS_API_BASE_URL, "https://gaemi0-fms-site.robotis.com:11000");
  assert.equal(FMS_LIVEKIT_URL, "wss://gaemi0-fms-site.robotis.com:11001");
});

test("normalizes numeric robot ids into idempotent FMS room names", () => {
  assert.equal(normalizeFmsRobotRoomName(42), "fms-robot-42");
  assert.equal(normalizeFmsRobotRoomName("007"), "fms-robot-007");
  assert.equal(
    normalizeFmsRobotRoomName(" fms-robot-19 "),
    "fms-robot-19",
  );
});

test("rejects invalid robot ids without echoing their value", () => {
  const invalidValue = "private-robot-label";
  assert.throws(
    () => normalizeFmsRobotRoomName(invalidValue),
    (error) => {
      assert.ok(error instanceof FmsClientError);
      assert.equal(error.code, "invalid_input");
      assert.equal(error.message.includes(invalidValue), false);
      return true;
    },
  );
});

test("logs in with JSON and retains the access token only in client memory", async () => {
  const { calls, fetchImpl } = recordedFetch([
    jsonResponse({ data: { accessToken: "memory-only-access-token" } }),
  ]);
  const client = new FmsClient({ fetchImpl });

  assert.equal(client.isAuthenticated, false);
  await authenticate(client);
  assert.equal(client.isAuthenticated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `${FMS_API_BASE_URL}/v1/auth/login`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.cache, "no-store");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email: EXAMPLE_EMAIL,
    password: EXAMPLE_PASSWORD,
  });
  assert.equal("accessToken" in client, false);

  client.clearSession();
  assert.equal(client.isAuthenticated, false);
});

test("loads the authenticated FMS profile and normalizes a numeric uid", async () => {
  const { calls, fetchImpl } = recordedFetch([
    jsonResponse({ data: { accessToken: "profile-access-token" } }),
    jsonResponse({
      data: { uid: 73, name: "Test Operator", email: EXAMPLE_EMAIL },
    }),
  ]);
  const client = new FmsClient({ fetchImpl });
  await authenticate(client);

  const profile = await client.getProfile();
  assert.deepEqual(profile, {
    uid: "73",
    name: "Test Operator",
    email: EXAMPLE_EMAIL,
  });
  assert.equal(calls[1].input, `${FMS_API_BASE_URL}/v1/auth/profile`);
  assert.equal(calls[1].init.method, "GET");
  assert.equal(
    new Headers(calls[1].init.headers).get("Authorization"),
    "Bearer profile-access-token",
  );
});

test("requests pilotMode LiveKit credentials for a normalized robot room", async () => {
  const { calls, fetchImpl } = recordedFetch([
    jsonResponse({ data: { accessToken: "livekit-access-token" } }),
    jsonResponse({ data: { token: "short-lived-livekit-token" } }),
  ]);
  const client = new FmsClient({ fetchImpl });
  await authenticate(client);

  const connection = await client.requestLiveKitToken({
    robotId: 314,
    participantIdentity: "safebot-observer",
  });
  assert.deepEqual(connection, {
    url: FMS_LIVEKIT_URL,
    token: "short-lived-livekit-token",
    roomName: "fms-robot-314",
    participantIdentity: "safebot-observer",
  });
  assert.equal(
    calls[1].input,
    `${FMS_API_BASE_URL}/v1/webrtc-server/token`,
  );
  assert.equal(calls[1].init.method, "POST");
  assert.equal(
    new Headers(calls[1].init.headers).get("Authorization"),
    "Bearer livekit-access-token",
  );
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    roomName: "fms-robot-314",
    participantIdentity: "safebot-observer",
    operationMode: "pilotMode",
  });
});

test("forwards AbortSignal and maps cancellation to a safe error", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const client = new FmsClient({
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });

  await assert.rejects(
    client.login(
      { email: EXAMPLE_EMAIL, password: EXAMPLE_PASSWORD },
      { signal: controller.signal },
    ),
    (error) => {
      assert.ok(error instanceof FmsClientError);
      assert.equal(error.code, "aborted");
      assert.equal(error.message, "FMS 요청이 취소되었습니다.");
      return true;
    },
  );
  assert.equal(called, false);
});

test("passes an active AbortSignal to profile and token requests", async () => {
  const controller = new AbortController();
  const { calls, fetchImpl } = recordedFetch([
    jsonResponse({ data: { accessToken: "abort-forward-token" } }),
    jsonResponse({
      data: { uid: "1", name: "Operator", email: EXAMPLE_EMAIL },
    }),
  ]);
  const client = new FmsClient({ fetchImpl });
  await authenticate(client);
  await client.getProfile({ signal: controller.signal });

  assert.equal(calls[1].init.signal, controller.signal);
});

test("does not expose credentials or server error bodies in login failures", async () => {
  const serverDetail = "internal-auth-stack-and-user-record";
  const client = new FmsClient({
    fetchImpl: async () => jsonResponse({ message: serverDetail }, 401),
  });

  await assert.rejects(
    client.login({ email: EXAMPLE_EMAIL, password: EXAMPLE_PASSWORD }),
    (error) => {
      assert.ok(error instanceof FmsClientError);
      assert.equal(error.code, "authentication_failed");
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(EXAMPLE_EMAIL), false);
      assert.equal(error.message.includes(EXAMPLE_PASSWORD), false);
      assert.equal(error.message.includes(serverDetail), false);
      return true;
    },
  );
  assert.equal(client.isAuthenticated, false);
});

test("clears the in-memory session when an authenticated request expires", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse({ data: { accessToken: "expired-access-token" } }),
    jsonResponse({ message: "do not expose this" }, 403),
  ]);
  const client = new FmsClient({ fetchImpl });
  await authenticate(client);

  await assert.rejects(client.getProfile(), (error) => {
    assert.ok(error instanceof FmsClientError);
    assert.equal(error.code, "session_expired");
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(client.isAuthenticated, false);
});

test("maps malformed and network responses to stable safe errors", async (t) => {
  await t.test("malformed success payload", async () => {
    const client = new FmsClient({
      fetchImpl: async () => jsonResponse({ data: { unexpected: true } }),
    });
    await assert.rejects(
      client.login({ email: EXAMPLE_EMAIL, password: EXAMPLE_PASSWORD }),
      (error) => {
        assert.ok(error instanceof FmsClientError);
        assert.equal(error.code, "invalid_response");
        return true;
      },
    );
  });

  await t.test("network exception", async () => {
    const underlyingMessage = "socket contained a private upstream detail";
    const client = new FmsClient({
      fetchImpl: async () => {
        throw new Error(underlyingMessage);
      },
    });
    await assert.rejects(
      client.login({ email: EXAMPLE_EMAIL, password: EXAMPLE_PASSWORD }),
      (error) => {
        assert.ok(error instanceof FmsClientError);
        assert.equal(error.code, "network_error");
        assert.equal(error.message.includes(underlyingMessage), false);
        return true;
      },
    );
  });
});
