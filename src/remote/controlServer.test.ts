import * as crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  generateSessionToken,
  pickDefaultBindHost,
  startRemoteControlServer,
  tokensMatchConstantTime,
  type RemoteControlFrame,
  type RemoteControlServerHandle,
} from "./controlServer.js";

afterEach(() => {
  vi.restoreAllMocks();
});

type ConnectionOutcome =
  | { kind: "open"; client: WebSocket }
  | { kind: "http"; statusCode: number | undefined }
  | { kind: "error"; message: string };

type ResolvedNetworkInfo = NonNullable<ReturnType<typeof import("node:os").networkInterfaces>[string]>[number];

function makeIpv4(address: string, internal = false): ResolvedNetworkInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

function waitForOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    const cleanup = (): void => {
      client.off("open", onOpen);
      client.off("unexpected-response", onUnexpectedResponse);
      client.off("error", onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve(client);
    };
    const onUnexpectedResponse = (_req: unknown, res: IncomingMessage): void => {
      cleanup();
      res.resume();
      reject(new Error(`Unexpected HTTP ${res.statusCode ?? "unknown"}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    client.once("open", onOpen);
    client.once("unexpected-response", onUnexpectedResponse);
    client.once("error", onError);
  });
}

function waitForConnectionOutcome(url: string): Promise<ConnectionOutcome> {
  return new Promise((resolve) => {
    const client = new WebSocket(url);
    let settled = false;
    const finish = (outcome: ConnectionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      client.removeAllListeners();
      resolve(outcome);
    };

    client.once("open", () => finish({ kind: "open", client }));
    client.once("unexpected-response", (_req: unknown, res: IncomingMessage) => {
      res.resume();
      finish({ kind: "http", statusCode: res.statusCode });
    });
    client.once("error", (error: Error) => {
      finish({ kind: "error", message: error.message });
    });
  });
}

function waitForFrame(client: WebSocket): Promise<RemoteControlFrame> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      client.off("message", onMessage);
      client.off("close", onClose);
      client.off("error", onError);
    };
    const onMessage = (raw: Buffer): void => {
      cleanup();
      resolve(JSON.parse(raw.toString("utf8")) as RemoteControlFrame);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Socket closed before a frame arrived"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    client.once("message", onMessage);
    client.once("close", onClose);
    client.once("error", onError);
  });
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    client.close();
  });
}

describe("remote control server", () => {
  it("accepts the correct token and answers ping with pong", async () => {
    const events: string[] = [];
    const server = await startRemoteControlServer({
      host: "127.0.0.1",
      onEvent: (event) => events.push(event.type),
    });
    let client: WebSocket | null = null;

    try {
      client = await waitForOpen(server.url);
      client.send(JSON.stringify({ type: "ping" }));
      const frame = await waitForFrame(client);
      expect(frame.type).toBe("pong");
      expect(typeof frame.ts).toBe("number");
      expect(events).toContain("client_connected");
    } finally {
      if (client) {
        await closeClient(client);
      }
      await server.stop();
    }
  });

  it("rejects a wrong token before any authenticated connection handler runs", async () => {
    const events: string[] = [];
    const server = await startRemoteControlServer({
      host: "127.0.0.1",
      onEvent: (event) => events.push(event.type),
    });

    try {
      const wrongToken = `${server.token.slice(0, -1)}${server.token.endsWith("A") ? "B" : "A"}`;
      await expect(waitForConnectionOutcome(`ws://127.0.0.1:${server.port}/?token=${wrongToken}`)).resolves.toEqual({
        kind: "http",
        statusCode: 401,
      });
      expect(events).toEqual(["started"]);
    } finally {
      await server.stop();
    }
  });

  it("rejects a missing token", async () => {
    const events: string[] = [];
    const server = await startRemoteControlServer({
      host: "127.0.0.1",
      onEvent: (event) => events.push(event.type),
    });

    try {
      await expect(waitForConnectionOutcome(`ws://127.0.0.1:${server.port}/`)).resolves.toEqual({
        kind: "http",
        statusCode: 401,
      });
      expect(events).toEqual(["started"]);
    } finally {
      await server.stop();
    }
  });

  it("rejects a second connection while one authenticated client is active", async () => {
    const server = await startRemoteControlServer({ host: "127.0.0.1" });
    let firstClient: WebSocket | null = null;

    try {
      firstClient = await waitForOpen(server.url);
      await expect(waitForConnectionOutcome(server.url)).resolves.toEqual({
        kind: "http",
        statusCode: 409,
      });
    } finally {
      if (firstClient) {
        await closeClient(firstClient);
      }
      await server.stop();
    }
  });

  it("uses a 32-byte random source for token generation", async () => {
    const randomBytesSpy = vi.fn(() => Buffer.alloc(32, 7));
    const server = await startRemoteControlServer({
      host: "127.0.0.1",
      randomBytesImpl: randomBytesSpy,
    });

    try {
      expect(randomBytesSpy).toHaveBeenCalledWith(32);
      expect(server.token).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      await server.stop();
    }
  });

  it("uses timingSafeEqual with equal-length buffers during token validation", async () => {
    const timingSafeEqualSpy = vi.fn((left: Buffer, right: Buffer) => crypto.timingSafeEqual(left, right));
    const server = await startRemoteControlServer({
      host: "127.0.0.1",
      timingSafeEqualImpl: timingSafeEqualSpy,
    });

    try {
      const wrongToken = `${server.token.slice(0, -1)}${server.token.endsWith("A") ? "B" : "A"}`;
      await expect(waitForConnectionOutcome(`ws://127.0.0.1:${server.port}/?token=${wrongToken}`)).resolves.toEqual({
        kind: "http",
        statusCode: 401,
      });
      expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
      const [expectedBuffer, providedBuffer] = timingSafeEqualSpy.mock.calls[0];
      expect(Buffer.isBuffer(expectedBuffer)).toBe(true);
      expect(Buffer.isBuffer(providedBuffer)).toBe(true);
      expect(providedBuffer.length).toBe(expectedBuffer.length);
    } finally {
      await server.stop();
    }
  });

  it("selects a specific default bind host instead of silently using 0.0.0.0", () => {
    const host = pickDefaultBindHost(() => ({
      lo: [makeIpv4("127.0.0.1", true)],
      eth0: [makeIpv4("192.168.1.25")],
      tailscale0: [makeIpv4("100.90.10.20")],
    }));

    expect(host).toBe("100.90.10.20");
    expect(host).not.toBe("0.0.0.0");
  });

  it("invalidates the old token after shutdown", async () => {
    const firstServer = await startRemoteControlServer({ host: "127.0.0.1", port: 0 });
    const { host, port, token } = firstServer;
    await firstServer.stop();

    const secondServer = await startRemoteControlServer({ host, port });
    try {
      await expect(waitForConnectionOutcome(`ws://${host}:${port}/?token=${token}`)).resolves.toEqual({
        kind: "http",
        statusCode: 401,
      });
    } finally {
      await secondServer.stop();
    }
  });

  it("pads mismatched token lengths before timingSafeEqual", () => {
    const timingSafeEqualSpy = vi.fn((left: Buffer, right: Buffer) => crypto.timingSafeEqual(left, right));

    const matched = tokensMatchConstantTime("expected-token", "short", timingSafeEqualSpy);

    expect(matched).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    const [expectedBuffer, providedBuffer] = timingSafeEqualSpy.mock.calls[0];
    expect(providedBuffer.length).toBe(expectedBuffer.length);
  });
});
