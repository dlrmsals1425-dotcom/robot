const ICE_CONFIG_ENDPOINT = "/api/live/ice-servers";
const ICE_CONFIG_TIMEOUT_MS = 4_000;
const MAX_ICE_SERVERS = 4;
const MAX_ICE_URLS_PER_SERVER = 8;
const MAX_ICE_VALUE_LENGTH = 1_024;

export const DEFAULT_LIVE_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

type IceConfigResponse = {
  iceServers?: unknown;
};

function isAllowedIceUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ICE_VALUE_LENGTH
  ) {
    return false;
  }
  return (
    /^stun:stun\.cloudflare\.com:(?:3478)$/u.test(value) ||
    /^turns?:turn\.cloudflare\.com:(?:3478|80|443|5349)(?:\?transport=(?:udp|tcp))?$/u.test(
      value,
    )
  );
}

function sanitizeIceServer(value: unknown): RTCIceServer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as {
    urls?: unknown;
    username?: unknown;
    credential?: unknown;
  };
  const rawUrls = Array.isArray(candidate.urls)
    ? candidate.urls
    : [candidate.urls];
  const urls = rawUrls
    .slice(0, MAX_ICE_URLS_PER_SERVER)
    .filter(isAllowedIceUrl);
  if (urls.length === 0) return null;

  const hasTurnUrl = urls.some((url) => url.startsWith("turn"));
  if (!hasTurnUrl) {
    return { urls: urls.length === 1 ? urls[0] : urls };
  }
  if (
    typeof candidate.username !== "string" ||
    candidate.username.length === 0 ||
    candidate.username.length > MAX_ICE_VALUE_LENGTH ||
    typeof candidate.credential !== "string" ||
    candidate.credential.length === 0 ||
    candidate.credential.length > MAX_ICE_VALUE_LENGTH
  ) {
    return null;
  }
  return {
    urls: urls.length === 1 ? urls[0] : urls,
    username: candidate.username,
    credential: candidate.credential,
  };
}

function sanitizeIceServers(value: unknown) {
  if (!Array.isArray(value)) return null;
  const servers = value
    .slice(0, MAX_ICE_SERVERS)
    .map(sanitizeIceServer)
    .filter((server): server is RTCIceServer => server !== null);
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => url.startsWith("turn"));
  })
    ? servers
    : null;
}

export function hasTurnIceServer(servers: RTCIceServer[]) {
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => url.startsWith("turn"));
  });
}

/**
 * Fetches short-lived TURN credentials from the authenticated SAFEBOT Worker.
 * The long-lived Cloudflare key never leaves the Worker. Any failure falls back
 * to free STUN and the existing one-frame-per-second privacy relay.
 */
export async function fetchLiveIceServers(): Promise<RTCIceServer[]> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    ICE_CONFIG_TIMEOUT_MS,
  );
  try {
    const response = await fetch(ICE_CONFIG_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return DEFAULT_LIVE_ICE_SERVERS;
    const payload = (await response.json()) as IceConfigResponse;
    return (
      sanitizeIceServers(payload.iceServers) ?? DEFAULT_LIVE_ICE_SERVERS
    );
  } catch {
    return DEFAULT_LIVE_ICE_SERVERS;
  } finally {
    window.clearTimeout(timeout);
  }
}
