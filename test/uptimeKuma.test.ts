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

      // The "monitorList" listener is registered synchronously before login is even sent
      // (it must be, to avoid racing Kuma's post-login push) - no need to wait a tick.
      expect(lastSocket.on).toHaveBeenCalledWith("monitorList", expect.any(Function));
      const monitorListHandler = lastSocket.on.mock.calls.find((c) => c[0] === "monitorList")?.[1];
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

    it("still resolves when Kuma pushes monitorList before the login ack (the real-world race)", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        let monitorListHandler: ((data: unknown) => void) | undefined;
        socket.on.mockImplementation((event: string, handler: (data: unknown) => void) => {
          if (event === "monitorList") monitorListHandler = handler;
        });
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          if (event === "login") {
            // Simulate Kuma pushing "monitorList" before the login ack callback fires.
            monitorListHandler!({
              "9": { id: 9, name: "Race", type: "http", url: "https://race.example", active: true, interval: 60 },
            });
            const cb = args[args.length - 1] as (res: { ok: boolean }) => void;
            cb({ ok: true });
          }
        };
        lastSocket = socket;
        return socket;
      });

      const action = findAction("list_monitors");
      const result = await action.handler({}, makeInstance());

      expect(result).toEqual([
        { id: 9, name: "Race", type: "http", url: "https://race.example", active: true, interval: 60 },
      ]);
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

  describe("add_http_monitor", () => {
    it("sends an empty conditions list (Uptime Kuma 2.x rejects NULL conditions)", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "add") cb({ ok: true, monitorID: 7 });
        };
        lastSocket = socket;
        return socket;
      });

      const action = findAction("add_http_monitor");
      const result = await action.handler({ name: "Site", url: "https://example.com" }, makeInstance());

      expect(result).toEqual({ monitorId: 7 });
      const addCall = lastSocket.emit.mock.calls.find((c) => c[0] === "add");
      expect(addCall?.[1]).toMatchObject({ type: "http", url: "https://example.com", conditions: [] });
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

  describe("edit_monitor", () => {
    it("waits for monitorList, merges given fields, and emits editMonitor", async () => {
      withLoginAck({ ok: true });

      const action = findAction("edit_monitor");
      const resultPromise = action.handler({ monitorId: 1, name: "Renamed" }, makeInstance());

      const monitorListHandler = lastSocket.on.mock.calls.find((c) => c[0] === "monitorList")?.[1];
      expect(monitorListHandler).toBeTypeOf("function");

      monitorListHandler!({
        "1": {
          id: 1,
          name: "Example",
          type: "http",
          url: "https://example.com",
          active: true,
          interval: 60,
        },
      });

      // Let the login ack and getRawMonitor's promise chain settle before editMonitor is emitted.
      for (let i = 0; i < 6; i++) await Promise.resolve();

      const editCall = lastSocket.emit.mock.calls.find((c) => c[0] === "editMonitor");
      expect(editCall).toBeDefined();
      const editCb = editCall![2] as (res: unknown) => void;
      editCb({ ok: true });

      const result = await resultPromise;
      expect(result).toEqual({ ok: true });
      expect(editCall![1]).toEqual({
        monitor: {
          id: 1,
          name: "Renamed",
          type: "http",
          url: "https://example.com",
          active: true,
          interval: 60,
        },
      });
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });

    it("rejects when the monitor is not in monitorList", async () => {
      withLoginAck({ ok: true });

      const action = findAction("edit_monitor");
      const resultPromise = action.handler({ monitorId: 5 }, makeInstance());

      const monitorListHandler = lastSocket.on.mock.calls.find((c) => c[0] === "monitorList")?.[1];
      monitorListHandler!({});

      await expect(resultPromise).rejects.toThrow("Monitor 5 not found");
    });
  });

  describe("list_notifications", () => {
    it("logs in, waits for the notificationList push, and returns it", async () => {
      withLoginAck({ ok: true });

      const action = findAction("list_notifications");
      const resultPromise = action.handler({}, makeInstance());

      await Promise.resolve();
      await Promise.resolve();

      expect(lastSocket.once).toHaveBeenCalledWith("notificationList", expect.any(Function));
      const handler = lastSocket.once.mock.calls.find((c) => c[0] === "notificationList")?.[1];
      handler!([{ id: 1, config: "{}", name: "email" }]);

      const result = await resultPromise;
      expect(result).toEqual([{ id: 1, config: "{}", name: "email" }]);
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe("list_maintenance", () => {
    it("emits getMaintenanceList and returns the maintenanceList", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "getMaintenanceList") cb({ ok: true, maintenanceList: [{ id: 1, title: "Window" }] });
        };
        lastSocket = socket;
        return socket;
      });

      const action = findAction("list_maintenance");
      const result = await action.handler({}, makeInstance());

      expect(result).toEqual([{ id: 1, title: "Window" }]);
      expect(lastSocket.emit).toHaveBeenCalledWith("getMaintenanceList", expect.any(Function));
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });

    it("rejects with the server's message when the request fails", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "getMaintenanceList") cb({ ok: false, msg: "not allowed" });
        };
        lastSocket = socket;
        return socket;
      });

      const action = findAction("list_maintenance");
      await expect(action.handler({}, makeInstance())).rejects.toThrow("not allowed");
    });
  });

  describe("add_maintenance", () => {
    it("emits addMaintenance with default strategy and monitor mapping", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "addMaintenance") cb({ ok: true, maintenanceID: 7 });
        };
        lastSocket = socket;
        return socket;
      });

      const action = findAction("add_maintenance");
      const result = await action.handler({ title: "Upgrade", monitorIds: [1, 2] }, makeInstance());

      expect(result).toEqual({ maintenanceId: 7 });
      expect(lastSocket.emit).toHaveBeenCalledWith(
        "addMaintenance",
        {
          title: "Upgrade",
          description: "",
          strategy: "manual",
          active: true,
          monitors: [{ id: 1 }, { id: 2 }],
          dateRange: [],
          weekdays: [],
          daysOfMonth: [],
          timeRange: [{ hours: 0, minutes: 0 }],
        },
        expect.any(Function)
      );
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe("list_status_pages", () => {
    it("emits getStatusPageList and returns the statusPageList object", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "getStatusPageList") cb({ ok: true, statusPageList: { default: { id: 1 } } });
        };
        lastSocket = socket;
        return socket;
      });

      const action = findAction("list_status_pages");
      const result = await action.handler({}, makeInstance());

      expect(result).toEqual({ default: { id: 1 } });
      expect(lastSocket.emit).toHaveBeenCalledWith("getStatusPageList", expect.any(Function));
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe("create_status_page", () => {
    it("emits addStatusPage with title and slug", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "addStatusPage") cb({ ok: true, slug: "public" });
        };
        lastSocket = socket;
        return socket;
      });

      const result = await findAction("create_status_page").handler({ title: "Status", slug: "public" }, makeInstance());

      expect(result).toMatchObject({ ok: true, slug: "public" });
      expect(lastSocket.emit).toHaveBeenCalledWith("addStatusPage", "Status", "public", expect.any(Function));
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });

    it("throws when Kuma rejects the page", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else cb({ ok: false, msg: "slug exists" });
        };
        lastSocket = socket;
        return socket;
      });

      await expect(findAction("create_status_page").handler({ title: "S", slug: "x" }, makeInstance())).rejects.toThrow(
        /slug exists/
      );
    });
  });

  describe("save_status_page", () => {
    it("merges the existing config and sends groups with monitor ids", async () => {
      ioMock.mockImplementationOnce(() => {
        const socket = createFakeSocket();
        socket.emitImpl = (event: string, ...args: unknown[]) => {
          const cb = args[args.length - 1] as (res: unknown) => void;
          if (event === "login") cb({ ok: true });
          else if (event === "getStatusPage")
            cb({ ok: true, config: { slug: "public", title: "Old", theme: "auto", icon: "/icon.svg" } });
          else if (event === "saveStatusPage") cb({ ok: true, publicGroupList: [] });
        };
        lastSocket = socket;
        return socket;
      });

      await findAction("save_status_page").handler(
        {
          slug: "public",
          title: "Systemstatus",
          domainNames: ["status.example.de"],
          groups: [{ name: "Websites", monitorIds: [1, 2] }],
        },
        makeInstance()
      );

      expect(lastSocket.emit).toHaveBeenCalledWith(
        "saveStatusPage",
        "public",
        expect.objectContaining({
          slug: "public",
          title: "Systemstatus",
          theme: "auto",
          icon: "/icon.svg",
          domainNameList: ["status.example.de"],
          published: true,
        }),
        "/icon.svg",
        [{ name: "Websites", monitorList: [{ id: 1 }, { id: 2 }] }],
        expect.any(Function)
      );
      expect(lastSocket.disconnect).toHaveBeenCalledOnce();
    });
  });
});
