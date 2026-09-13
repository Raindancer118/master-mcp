import { z } from "zod";
import { io, type Socket } from "socket.io-client";
import type { ActionDef, AnyActionDef, InstanceConfig, ServiceModule } from "../core/types.js";
import { requireField } from "../core/http.js";

interface LoginAck {
  ok: boolean;
  msg?: string;
  tokenRequired?: boolean;
  token?: string;
}

interface SimpleAck {
  ok: boolean;
  msg?: string;
}

interface MonitorObject {
  id: number;
  name: string;
  type: string;
  url?: string;
  hostname?: string;
  active: boolean;
  interval: number;
  [key: string]: unknown;
}

const LOGIN_TIMEOUT_MS = 8_000;
const MONITOR_LIST_TIMEOUT_MS = 5_000;

/** Fields required to reach one Uptime Kuma instance's Socket.IO admin interface. */
function credsFor(instance: InstanceConfig): { baseUrl: string; username: string; password: string } {
  const baseUrl = requireField(instance.fields, "baseUrl", "Uptime Kuma").replace(/\/+$/, "");
  const username = requireField(instance.fields, "username", "Uptime Kuma");
  const password = requireField(instance.fields, "password", "Uptime Kuma");
  return { baseUrl, username, password };
}

/**
 * Opens a fresh Socket.IO connection to this instance, logs in, runs `fn` with the
 * authenticated socket, then always disconnects - even if login or `fn` throws.
 * Uptime Kuma has no write REST API; all mutation goes through this Socket.IO channel.
 */
async function withSession<T>(instance: InstanceConfig, fn: (socket: Socket) => Promise<T>): Promise<T> {
  const { baseUrl, username, password } = credsFor(instance);
  const socket: Socket = io(baseUrl, { transports: ["websocket"], reconnection: false });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Uptime Kuma login timed out (no response from server)"));
      }, LOGIN_TIMEOUT_MS);

      socket.on("connect_error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Uptime Kuma connection failed: ${err.message}`));
      });

      socket.emit("login", { username, password, token: "" }, (res: LoginAck) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res.tokenRequired) {
          reject(
            new Error(
              "Uptime Kuma login requires 2FA - accounts with two-factor authentication enabled are not supported by this integration"
            )
          );
          return;
        }
        if (!res.ok) {
          reject(new Error(res.msg ?? "Uptime Kuma login failed"));
          return;
        }
        resolve();
      });
    });

    return await fn(socket);
  } finally {
    socket.disconnect();
  }
}

/** Wraps an ack-style Socket.IO call (`emit(event, ...args, callback)`) as a Promise. */
function emitAck<R>(socket: Socket, event: string, args: unknown[]): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Uptime Kuma "${event}" timed out waiting for a response`));
    }, LOGIN_TIMEOUT_MS);
    socket.emit(event, ...args, (res: R) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function trimMonitor(m: MonitorObject) {
  return {
    id: m.id,
    name: m.name,
    type: m.type,
    url: m.url ?? m.hostname,
    active: m.active,
    interval: m.interval,
  };
}

const emptyParams = z.object({});

const monitorIdParams = z.object({
  monitorId: z.number().int(),
});

const getMonitorBeatsParams = z.object({
  monitorId: z.number().int(),
  period: z.number().positive().optional(),
});

const addHttpMonitorParams = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  interval: z.number().int().positive().optional(),
  retryInterval: z.number().int().positive().optional(),
  resendInterval: z.number().int().nonnegative().optional(),
});

function buildActions(): AnyActionDef[] {
  const listMonitors: ActionDef<z.infer<typeof emptyParams>> = {
    id: "list_monitors",
    summary: "List all monitors (id, name, type, url/hostname, active state, check interval) configured in Uptime Kuma.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      return withSession(instance, (socket) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for "monitorList" from Uptime Kuma after login'));
          }, MONITOR_LIST_TIMEOUT_MS);

          socket.once("monitorList", (data: Record<string, MonitorObject>) => {
            clearTimeout(timer);
            resolve(Object.values(data).map(trimMonitor));
          });
        });
      });
    },
  };

  const getMonitorBeats: ActionDef<z.infer<typeof getMonitorBeatsParams>> = {
    id: "get_monitor_beats",
    summary: "Get historical heartbeats (up/down status over time) for one monitor, over a given period in hours.",
    paramsSchema: getMonitorBeatsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      return withSession(instance, async (socket) => {
        const res = await emitAck<{ ok: boolean; data?: unknown[]; msg?: string }>(socket, "getMonitorBeats", [
          params.monitorId,
          params.period ?? 24,
        ]);
        if (!res.ok) throw new Error(res.msg ?? "get_monitor_beats failed");
        return res.data ?? [];
      });
    },
  };

  const pauseMonitor: ActionDef<z.infer<typeof monitorIdParams>> = {
    id: "pause_monitor",
    summary: "Pause a monitor, stopping its checks and alerting until resumed.",
    paramsSchema: monitorIdParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      return withSession(instance, async (socket) => {
        const res = await emitAck<SimpleAck>(socket, "pauseMonitor", [params.monitorId]);
        if (!res.ok) throw new Error(res.msg ?? "pause_monitor failed");
        return { ok: true };
      });
    },
  };

  const resumeMonitor: ActionDef<z.infer<typeof monitorIdParams>> = {
    id: "resume_monitor",
    summary: "Resume a previously paused monitor.",
    paramsSchema: monitorIdParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      return withSession(instance, async (socket) => {
        const res = await emitAck<SimpleAck>(socket, "resumeMonitor", [params.monitorId]);
        if (!res.ok) throw new Error(res.msg ?? "resume_monitor failed");
        return { ok: true };
      });
    },
  };

  const deleteMonitor: ActionDef<z.infer<typeof monitorIdParams>> = {
    id: "delete_monitor",
    summary: "Permanently delete a monitor and its history. Irreversible.",
    paramsSchema: monitorIdParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      return withSession(instance, async (socket) => {
        const res = await emitAck<SimpleAck>(socket, "deleteMonitor", [params.monitorId]);
        if (!res.ok) throw new Error(res.msg ?? "delete_monitor failed");
        return { ok: true };
      });
    },
  };

  const addHttpMonitor: ActionDef<z.infer<typeof addHttpMonitorParams>> = {
    id: "add_http_monitor",
    summary: "Create a new HTTP(s) monitor that periodically checks a URL for availability.",
    paramsSchema: addHttpMonitorParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      return withSession(instance, async (socket) => {
        const monitor = {
          type: "http",
          name: params.name,
          url: params.url,
          method: "GET",
          interval: params.interval ?? 60,
          retryInterval: params.retryInterval ?? 60,
          resendInterval: params.resendInterval ?? 0,
          maxretries: 0,
          accepted_statuscodes: ["200-299"],
          notificationIDList: {},
        };
        const res = await emitAck<{ ok: boolean; msg?: string; monitorID?: number }>(socket, "add", [monitor]);
        if (!res.ok) throw new Error(res.msg ?? "add_http_monitor failed");
        return { monitorId: res.monitorID };
      });
    },
  };

  return [listMonitors, getMonitorBeats, pauseMonitor, resumeMonitor, deleteMonitor, addHttpMonitor];
}

const uptimeKumaService: ServiceModule = {
  id: "uptime_kuma",
  label: "Uptime Kuma",
  description: "Uptime Kuma monitor administration (list/add/pause/resume/delete monitors, read heartbeats) via its Socket.IO admin channel.",
  parseInstanceFields: (fields) => {
    const baseUrl = requireField(fields, "baseUrl", "Uptime Kuma").replace(/\/+$/, "");
    const username = requireField(fields, "username", "Uptime Kuma");
    const password = requireField(fields, "password", "Uptime Kuma");
    return { baseUrl, username, password };
  },
  exampleFields: ["BASE_URL", "USERNAME", "PASSWORD"],
  buildActions,
};

export default uptimeKumaService;
