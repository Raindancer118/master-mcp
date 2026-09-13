import { describe, expect, it, vi, beforeEach } from "vitest";
import type { InstanceConfig } from "../src/core/types.js";

// Fake Socket.IO client: a minimal EventEmitter-like stand-in for the real `Socket`.
// `emit` is driven per-test via `emitImpl`; `on`/`once` just record handlers so a test
// can trigger a server-pushed event (e.g. "monitorList") manually.
interface FakeSocket {
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emitImpl: (event: string, ...args: unknown[]) => void;
}

function createFakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    emitImpl: () => {
      throw new Error("emitImpl not configured for this event");
    },
    on: vi.fn(),
    once: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      socket.emitImpl(event, ...args);
    }),
  };
  return socket;
}

let lastSocket: FakeSocket;
const ioMock = vi.fn(() => {
  lastSocket = createFakeSocket();
  return lastSocket;
});

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

// Import after mocking so the module under test picks up the mocked `io`.
const uptimeKumaService = (await import("../src/services/uptimeKuma.js")).default;

function findAction(id: string) {
  const action = uptimeKumaService.buildActions().find((a) => a.id === id);
  if (!action) throw new Error(`action ${id} not found`);
  return action;
}

function makeInstance(fields: Record<string, string> = {}): InstanceConfig {
  return {
    id: "default",
    fields: { baseUrl: "http://10.0.0.5:3001", username: "admin", password: "secret", ...fields },
  };
}

/** Configures the fake socket's login handling for the session that is about to be opened. */
function withLoginAck(loginAck: { ok: boolean; msg?: string; tokenRequired?: boolean }) {
  ioMock.mockImplementationOnce(() => {
    const socket = createFakeSocket();
    socket.emitImpl = (event: string, ...args: unknown[]) => {
      if (event === "login") {
        const cb = args[args.length - 1] as (res: typeof loginAck) => void;
        cb(loginAck);
      }
    };
    lastSocket = socket;
    return socket;
  });
}

describe("uptimeKuma service", () => {
  beforeEach(() => {
    ioMock.mockClear();
  });

  describe("parseInstanceFields", () => {
    it("throws when a required field is missing", () => {
      expect(() => uptimeKumaService.parseInstanceFields({ username: "admin", password: "secret" })).toThrow(
        /baseUrl|BASE_URL/i
      );
    });

    it("succeeds with valid fields", () => {
      const result = uptimeKumaService.parseInstanceFields({
        baseUrl: "http://10.0.0.5:3001/",
        username: "admin",
        password: "secret",
      });
      expect(result).toEqual({
        baseUrl: "http://10.0.0.5:3001",
        username: "admin",
        password: "secret",
      });
    });
  });

  describe("list_monitors", () => {
    it("logs in, waits for the monitorList push, and returns trimmed monitors", async () => {
      withLoginAck({ ok: true });

      const action = findAction("list_monitors");
      const resultPromise = action.handler({}, makeInstance());

      // Wait a tick so the handler has registered its "monitorList" listener.
      await Promise.resolve();
      await Promise.resolve();

      expect(lastSocket.once).toHaveBeenCalledWith("monitorList", expect.any(Function));
      const monitorListHandler = lastSocket.once.mock.calls.find((c) => c[0] === "monitorList")?.[1];
      expect(monitorListHandler).toBeTypeOf("function");

      monitorListHandler!({
        "1": {
          id: 1,
          name: "Example",
          type: "http",
          url: "https://example.com",
          active: true,
          interval: 60,
          extraField: "ignored",
        },
        "2": {
          id: 2,
          name: "Local box",
          type: "ping",
          hostname: "10.0.0.5",
          active: false,
          interval: 30,
        },
      });

      const result = await resultPromise;
      expect(result).toEqual([
        { id: 1, name: "Example", type: "http", url: "https://example.com", active: true, interval: 60 },
        { id: 2, name: "Local box", type: "ping", url: "10.0.0.5", active: false, interval: 30 },
      ]);
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe("login failures", () => {
    it("rejects with the server's message on bad credentials", async () => {
      withLoginAck({ ok: false, msg: "Incorrect username or password" });

      const action = findAction("list_monitors");
      await expect(action.handler({}, makeInstance())).rejects.toThrow("Incorrect username or password");
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });

    it("rejects clearly when the account requires 2FA", async () => {
      withLoginAck({ ok: true, tokenRequired: true });

      const action = findAction("list_monitors");
      await expect(action.handler({}, makeInstance())).rejects.toThrow(/2FA/i);
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe("pause_monitor", () => {
    it("emits pauseMonitor with the given monitor id", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "pauseMonitor") cb({ ok: true });
        };
        lastSocket = socket;
        return socket;
      });

      const action = findAction("pause_monitor");
      const result = await action.handler({ monitorId: 42 }, makeInstance());

      expect(result).toEqual({ ok: true });
      expect(lastSocket.emit).toHaveBeenCalledWith("pauseMonitor", 42, expect.any(Function));
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });

    it("rejects with the server's message when pausing fails", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "pauseMonitor") cb({ ok: false, msg: "Monitor not found" });
        };
        lastSocket = socket;
        return socket;
      });

      const action = findAction("pause_monitor");
      await expect(action.handler({ monitorId: 99 }, makeInstance())).rejects.toThrow("Monitor not found");
    });
  });
});
