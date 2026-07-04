import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { RemoteControlBackend } from "./remoteControlBackend.js";

const REMOTE_CONTROL_PATH = "/";
const REMOTE_CONTROL_TOKEN_BYTES = 32;
const REMOTE_CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const WS_CLOSE_GOING_AWAY = 1001;
const WS_CLOSE_UNSUPPORTED_DATA = 1003;
const WS_CLOSE_POLICY_VIOLATION = 1008;

/**
 * Remote-control frame protocol (Inc-1a).
 *
 * Client → server:
 *   { "type": "ping" }
 *
 * Server → client:
 *   { "type": "pong", "ts": <epoch_ms> }
 *
 * All frames MUST be JSON objects with a string `type` field.
 * Inc-1b extends this protocol with authenticated session-driving messages.
 */
export interface RemoteControlFrame {
  type: string;
  [key: string]: unknown;
}

export interface RemoteControlLifecycleEvent {
  type: "started" | "client_connected" | "client_disconnected" | "stopped";
  host?: string;
  port?: number;
  url?: string;
  remoteAddress?: string | null;
  code?: number;
  reason?: string;
}

export interface StartRemoteControlServerOptions {
  host?: string;
  port?: number;
  path?: string;
  env?: NodeJS.ProcessEnv;
  networkInterfacesImpl?: typeof networkInterfaces;
  randomBytesImpl?: typeof randomBytes;
  timingSafeEqualImpl?: typeof timingSafeEqual;
  onEvent?: (event: RemoteControlLifecycleEvent) => void;
}

export interface RemoteControlServerHandle {
  host: string;
  port: number;
  path: string;
  token: string;
  url: string;
  stop: () => Promise<void>;
  /** Send a frame to the currently connected client. No-op when no client is connected. */
  broadcast: (frame: RemoteControlFrame) => void;
  /** Wire the backend that handles submit/abort frames. Call once after construction. */
  setBackend: (backend: RemoteControlBackend) => void;
}

interface BindCandidate {
  name: string;
  address: string;
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

type UpgradeSocket = {
  write: (chunk: string) => unknown;
  destroy: () => void;
};

function writeUpgradeRejection(
  socket: UpgradeSocket,
  statusCode: number,
  statusText: string,
  payload: Record<string, unknown>
): void {
  const body = JSON.stringify(payload);
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      "Connection: close\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body
  );
  socket.destroy();
}

type ResolvedNetworkInfo = NonNullable<ReturnType<typeof networkInterfaces>[string]>[number];

function isIpv4Address(info: ResolvedNetworkInfo): boolean {
  return info.family === "IPv4";
}

function isTailscaleAddress(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
    return false;
  }

  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function pickDefaultBindHost(
  networkInterfacesImpl: typeof networkInterfaces = networkInterfaces
): string {
  const allInterfaces = networkInterfacesImpl();
  const candidates: BindCandidate[] = [];

  for (const [name, infos] of Object.entries(allInterfaces)) {
    for (const info of infos ?? []) {
      if (!isIpv4Address(info) || info.internal) {
        continue;
      }
      candidates.push({ name, address: info.address });
    }
  }

  const tailscaleByName = candidates.find((candidate) =>
    candidate.name.toLowerCase().includes("tailscale")
  );
  if (tailscaleByName) {
    return tailscaleByName.address;
  }

  const tailscaleByRange = candidates.find((candidate) =>
    isTailscaleAddress(candidate.address)
  );
  if (tailscaleByRange) {
    return tailscaleByRange.address;
  }

  if (candidates[0]) {
    return candidates[0].address;
  }

  throw new Error(
    "No reachable IPv4 interface found for remote control. Set ZONE_REMOTE_CONTROL_HOST to override."
  );
}

export function generateSessionToken(
  randomBytesImpl: typeof randomBytes = randomBytes
): string {
  return randomBytesImpl(REMOTE_CONTROL_TOKEN_BYTES).toString("base64url");
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid remote control port override: ${value}`);
  }

  return parsed;
}

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? REMOTE_CONTROL_PATH, `http://${req.headers.host ?? "127.0.0.1"}`);
}

function getTokenFromRequest(req: IncomingMessage): string | undefined {
  const fromQuery = getRequestUrl(req).searchParams.get("token")?.trim();
  if (fromQuery) {
    return fromQuery;
  }

  const authorization = req.headers.authorization?.trim();
  if (!authorization) {
    return undefined;
  }

  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : authorization;
}

export function tokensMatchConstantTime(
  expectedToken: string,
  providedToken: string | undefined,
  timingSafeEqualImpl: typeof timingSafeEqual = timingSafeEqual
): boolean {
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = typeof providedToken === "string"
    ? Buffer.from(providedToken)
    : Buffer.alloc(0);
  const comparableBuffer = providedBuffer.length === expectedBuffer.length
    ? providedBuffer
    : Buffer.alloc(expectedBuffer.length);

  return timingSafeEqualImpl(expectedBuffer, comparableBuffer)
    && providedBuffer.length === expectedBuffer.length;
}

function buildRemoteControlUrl(host: string, port: number, path: string, token: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `ws://${host}:${port}${normalizedPath}?token=${encodeURIComponent(token)}`;
}

function serializeFrame(frame: RemoteControlFrame): string {
  return JSON.stringify(frame);
}

function parseFrame(raw: RawData): RemoteControlFrame | null {
  try {
    const decoded = JSON.parse(raw.toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || typeof (decoded as { type?: unknown }).type !== "string") {
      return null;
    }
    return decoded as RemoteControlFrame;
  } catch {
    return null;
  }
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      client.terminate();
      finish();
    }, 250);

    client.once("close", () => {
      clearTimeout(timeout);
      finish();
    });
    client.close(WS_CLOSE_GOING_AWAY, "remote-control-stopping");
  });
}

export async function startRemoteControlServer(
  options: StartRemoteControlServerOptions = {}
): Promise<RemoteControlServerHandle> {
  const env = options.env ?? process.env;
  const path = options.path ?? REMOTE_CONTROL_PATH;
  const host = options.host ?? env.ZONE_REMOTE_CONTROL_HOST ?? pickDefaultBindHost(options.networkInterfacesImpl);
  const port = options.port ?? parsePort(env.ZONE_REMOTE_CONTROL_PORT) ?? 0;
  const timingSafeEqualImpl = options.timingSafeEqualImpl ?? timingSafeEqual;
  let sessionToken: string | null = generateSessionToken(options.randomBytesImpl);
  let activeClient: WebSocket | null = null;
  let stopped = false;
  let backend: RemoteControlBackend | null = null;
  const setBackend = (b: RemoteControlBackend): void => { backend = b; };

  const server = createServer((req, res) => {
    const requestUrl = getRequestUrl(req);
    if (req.method !== "GET" || requestUrl.pathname !== path) {
      sendJson(res, 404, { ok: false, reason: "Not found" });
      return;
    }

    sendJson(res, 426, { ok: false, reason: "WebSocket upgrade required" });
  });

  server.requestTimeout = REMOTE_CONTROL_REQUEST_TIMEOUT_MS;
  server.headersTimeout = REMOTE_CONTROL_REQUEST_TIMEOUT_MS;

  const wss = new WebSocketServer({ noServer: true });

  const emitEvent = (event: RemoteControlLifecycleEvent): void => {
    options.onEvent?.(event);
  };

  const broadcast = (frame: RemoteControlFrame): void => {
    if (activeClient && activeClient.readyState === WebSocket.OPEN) {
      activeClient.send(serializeFrame(frame));
    }
  };

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;

    const client = activeClient;
    activeClient = null;
    sessionToken = null;

    if (client) {
      await closeClient(client);
    }

    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    emitEvent({ type: "stopped" });
  };

  wss.on("connection", (client, req) => {
    activeClient = client;
    emitEvent({
      type: "client_connected",
      remoteAddress: req.socket.remoteAddress ?? null,
    });

    client.on("message", (raw) => {
      const frame = parseFrame(raw);
      if (!frame) {
        client.close(WS_CLOSE_UNSUPPORTED_DATA, "invalid-json-frame");
        return;
      }

      if (frame.type === "ping") {
        client.send(serializeFrame({ type: "pong", ts: Date.now() }));
        return;
      }

      if (frame.type === "submit") {
        const task = typeof frame.task === "string" ? frame.task.trim() : "";
        const mode = frame.mode;
        if (!task) {
          broadcast({ type: "error", reason: "submit_invalid_task", ts: Date.now() });
          return;
        }
        if (mode !== undefined && mode !== "normal" && mode !== "autoAccept" && mode !== "plan") {
          broadcast({ type: "error", reason: "submit_invalid_mode", ts: Date.now() });
          return;
        }
        void backend?.startRun(task, { mode: mode as "normal" | "autoAccept" | "plan" | undefined });
        return;
      }

      if (frame.type === "abort") {
        backend?.abort();
        return;
      }

      if (frame.type === "approval_response") {
        const res = backend?.resolveApproval({
          kind: frame.kind as "command" | "edit" | "trust" | "plan" | "staged" | "revision",
          id: typeof frame.id === "string" ? frame.id : "",
          approved: frame.approved as boolean | undefined,
          decision: frame.decision as string | undefined,
          feedback: frame.feedback as string | undefined,
          trust: frame.trust as boolean | undefined,
        }) ?? { ok: false, message: "no_backend" };
        client.send(serializeFrame({
          type: "approval_ack",
          ...(typeof frame.id === "string" && { id: frame.id }),
          ok: res.ok,
          ...(res.message !== undefined && { message: res.message }),
        }));
        return;
      }

      client.close(WS_CLOSE_POLICY_VIOLATION, "unsupported-frame-type");
    });

    client.on("close", (code, reason) => {
      if (activeClient === client) {
        activeClient = null;
      }
      emitEvent({
        type: "client_disconnected",
        code,
        reason: reason.toString("utf8"),
      });
    });

    client.on("error", () => {
      // Best-effort only; close events surface lifecycle state.
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = getRequestUrl(req);
    if (requestUrl.pathname !== path) {
      writeUpgradeRejection(socket, 404, "Not Found", { ok: false, reason: "Not found" });
      return;
    }

    const providedToken = getTokenFromRequest(req);
    if (!sessionToken || !tokensMatchConstantTime(sessionToken, providedToken, timingSafeEqualImpl)) {
      writeUpgradeRejection(socket, 401, "Unauthorized", { ok: false, reason: "Invalid remote control token" });
      return;
    }

    if (activeClient) {
      writeUpgradeRejection(socket, 409, "Conflict", { ok: false, reason: "Remote control is already in use" });
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit("connection", client, req);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string" || !sessionToken) {
    await stop();
    throw new Error("Remote control failed to determine its listening address.");
  }

  const url = buildRemoteControlUrl(host, address.port, path, sessionToken);
  emitEvent({ type: "started", host, port: address.port, url });

  return {
    host,
    port: address.port,
    path,
    token: sessionToken,
    url,
    stop,
    broadcast,
    setBackend,
  };
}
