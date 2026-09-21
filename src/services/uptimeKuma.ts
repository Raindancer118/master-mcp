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

/** Context handed to `withSession` callbacks: the authenticated socket, plus a way to read the
 * "monitorList" push without racing it. */
interface Session {
  socket: Socket;
  /** Resolves with the most recent "monitorList" payload - cached if it already arrived
   * (typically right after login), otherwise waits for the next one. */
  waitForMonitorList: (timeoutMs?: number) => Promise<Record<string, MonitorObject>>;
}

/**
 * Opens a fresh Socket.IO connection to this instance, logs in, runs `fn` with the
 * authenticated session, then always disconnects - even if login or `fn` throws.
 * Uptime Kuma has no write REST API; all mutation goes through this Socket.IO channel.
 */
async function withSession<T>(instance: InstanceConfig, fn: (session: Session) => Promise<T>): Promise<T> {
  const { baseUrl, username, password } = credsFor(instance);
  const socket: Socket = io(baseUrl, { transports: ["websocket"], reconnection: false });

  // Uptime Kuma pushes "monitorList" as soon as login succeeds - often before the login ack
  // callback even fires. The listener must be attached before login is sent, or the event is
  // missed and any listMonitors/editMonitor call hangs until timeout.
  let cachedMonitorList: Record<string, MonitorObject> | undefined;
  let monitorListWaiters: Array<(data: Record<string, MonitorObject>) => void> = [];
  socket.on("monitorList", (data: Record<string, MonitorObject>) => {
    cachedMonitorList = data;
    const waiters = monitorListWaiters;
    monitorListWaiters = [];
    for (const waiter of waiters) waiter(data);
  });

  function waitForMonitorList(timeoutMs = MONITOR_LIST_TIMEOUT_MS): Promise<Record<string, MonitorObject>> {
    if (cachedMonitorList) return Promise.resolve(cachedMonitorList);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        monitorListWaiters = monitorListWaiters.filter((w) => w !== onData);
        reject(new Error('Timed out waiting for "monitorList" from Uptime Kuma after login'));
      }, timeoutMs);
      const onData = (data: Record<string, MonitorObject>) => {
        clearTimeout(timer);
        resolve(data);
      };
      monitorListWaiters.push(onData);
    });
  }

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

    return await fn({ socket, waitForMonitorList });
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

const editMonitorParams = z.object({
  monitorId: z.number().int(),
  name: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  interval: z.number().int().positive().optional(),
  retryInterval: z.number().int().positive().optional(),
  resendInterval: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});

const createStatusPageParams = z.object({
  title: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug: lowercase letters, digits, dashes"),
});

const saveStatusPageParams = z.object({
  slug: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  footerText: z.string().optional(),
  domainNames: z.array(z.string().min(1)).optional(),
  showTags: z.boolean().optional(),
  showPoweredBy: z.boolean().optional(),
  showCertificateExpiry: z.boolean().optional(),
  published: z.boolean().optional(),
  groups: z.array(z.object({ name: z.string().min(1), monitorIds: z.array(z.number().int()) })),
});

const addMaintenanceParams = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  strategy: z.enum(["manual", "single", "recurring-interval"]).optional(),
  monitorIds: z.array(z.number().int()).optional(),
});

/**
 * Waits for the pushed "monitorList" event (or its cached value) and returns the raw
 * (untrimmed) object for `monitorId` from it. Used whenever a full monitor definition is
 * needed (e.g. to merge partial edits before re-submitting it).
 */
async function getRawMonitor(session: Session, monitorId: number): Promise<MonitorObject> {
  const data = await session.waitForMonitorList();
  const monitor = data[String(monitorId)];
  if (!monitor) {
    throw new Error(`Monitor ${monitorId} not found`);
  }
  return monitor;
}

function buildActions(): AnyActionDef[] {
  const listMonitors: ActionDef<z.infer<typeof emptyParams>> = {
    id: "list_monitors",
    summary: "List all monitors (id, name, type, url/hostname, active state, check interval) configured in Uptime Kuma.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      return withSession(instance, async ({ waitForMonitorList }) => {
        const data = await waitForMonitorList();
        return Object.values(data).map(trimMonitor);
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
      return withSession(instance, async ({ socket }) => {
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
      return withSession(instance, async ({ socket }) => {
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
      return withSession(instance, async ({ socket }) => {
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
      return withSession(instance, async ({ socket }) => {
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
      return withSession(instance, async ({ socket }) => {
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

  const editMonitor: ActionDef<z.infer<typeof editMonitorParams>> = {
    id: "edit_monitor",
    summary: "Edit an existing monitor's name, URL, check interval, retry interval, resend interval, or active state.",
    paramsSchema: editMonitorParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      return withSession(instance, async (session) => {
        const current = await getRawMonitor(session, params.monitorId);
        const merged: MonitorObject = {
          ...current,
          id: params.monitorId,
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.url !== undefined ? { url: params.url } : {}),
          ...(params.interval !== undefined ? { interval: params.interval } : {}),
          ...(params.retryInterval !== undefined ? { retryInterval: params.retryInterval } : {}),
          ...(params.resendInterval !== undefined ? { resendInterval: params.resendInterval } : {}),
          ...(params.active !== undefined ? { active: params.active } : {}),
        };
        const res = await emitAck<{ ok: boolean; msg?: string }>(session.socket, "editMonitor", [{ monitor: merged }]);
        if (!res.ok) throw new Error(res.msg ?? "edit_monitor failed");
        return { ok: true };
      });
    },
  };

  const listNotifications: ActionDef<z.infer<typeof emptyParams>> = {
    id: "list_notifications",
    summary: "List all configured notification providers (e.g. email, Discord, Telegram) in Uptime Kuma.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      return withSession(instance, ({ socket }) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for "notificationList" from Uptime Kuma after login'));
          }, MONITOR_LIST_TIMEOUT_MS);

          socket.once("notificationList", (data: unknown[]) => {
            clearTimeout(timer);
            resolve(data);
          });
        });
      });
    },
  };

  const listMaintenance: ActionDef<z.infer<typeof emptyParams>> = {
    id: "list_maintenance",
    summary: "List all maintenance windows configured in Uptime Kuma.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      return withSession(instance, async ({ socket }) => {
        const res = await emitAck<{ ok: boolean; msg?: string; maintenanceList?: unknown[] }>(
          socket,
          "getMaintenanceList",
          []
        );
        if (!res.ok) throw new Error(res.msg ?? "list_maintenance failed");
        return res.maintenanceList ?? [];
      });
    },
  };

  const addMaintenance: ActionDef<z.infer<typeof addMaintenanceParams>> = {
    id: "add_maintenance",
    summary: "Create a maintenance window, optionally scoped to specific monitors, to suppress alerts during planned downtime.",
    paramsSchema: addMaintenanceParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      return withSession(instance, async ({ socket }) => {
        const maintenance = {
          title: params.title,
          description: params.description ?? "",
          strategy: params.strategy ?? "manual",
          active: true,
          monitors: (params.monitorIds ?? []).map((id) => ({ id })),
          dateRange: [],
          weekdays: [],
          daysOfMonth: [],
          timeRange: [{ hours: 0, minutes: 0 }],
        };
        const res = await emitAck<{ ok: boolean; msg?: string; maintenanceID?: number }>(socket, "addMaintenance", [
          maintenance,
        ]);
        if (!res.ok) throw new Error(res.msg ?? "add_maintenance failed");
        return { maintenanceId: res.maintenanceID };
      });
    },
  };

  const listStatusPages: ActionDef<z.infer<typeof emptyParams>> = {
    id: "list_status_pages",
    summary: "List all public status pages configured in Uptime Kuma, keyed by slug.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      return withSession(instance, async ({ socket }) => {
        const res = await emitAck<{ ok: boolean; msg?: string; statusPageList?: unknown }>(
          socket,
          "getStatusPageList",
          []
        );
        if (!res.ok) throw new Error(res.msg ?? "list_status_pages failed");
        return res.statusPageList ?? {};
      });
    },
  };

  const createStatusPage: ActionDef<z.infer<typeof createStatusPageParams>> = {
    id: "create_status_page",
    summary: "Create an empty status page (title + slug). Fill it afterwards with save_status_page.",
    paramsSchema: createStatusPageParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      return withSession(instance, async ({ socket }) => {
        const res = await emitAck<SimpleAck & { slug?: string }>(socket, "addStatusPage", [params.title, params.slug]);
        if (!res.ok) throw new Error(res.msg ?? "create_status_page failed");
        return res;
      });
    },
  };

  const saveStatusPage: ActionDef<z.infer<typeof saveStatusPageParams>> = {
    id: "save_status_page",
    summary:
      "Configure a status page: title, description, footer, custom domains, visibility options and the full list of monitor groups (replaces existing groups). Unspecified settings keep their current value.",
    paramsSchema: saveStatusPageParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      return withSession(instance, async ({ socket }) => {
        const current = await emitAck<SimpleAck & { config?: Record<string, unknown> }>(socket, "getStatusPage", [
          params.slug,
        ]);
        if (!current.ok) throw new Error(current.msg ?? `status page "${params.slug}" not found`);
        const config: Record<string, unknown> = { ...(current.config ?? {}), slug: params.slug };
        if (params.title !== undefined) config.title = params.title;
        if (params.description !== undefined) config.description = params.description;
        if (params.footerText !== undefined) config.footerText = params.footerText;
        if (params.domainNames !== undefined) config.domainNameList = params.domainNames;
        if (params.showTags !== undefined) config.showTags = params.showTags;
        if (params.showPoweredBy !== undefined) config.showPoweredBy = params.showPoweredBy;
        if (params.showCertificateExpiry !== undefined) config.showCertificateExpiry = params.showCertificateExpiry;
        config.published = params.published ?? config.published ?? true;
        const groups = params.groups.map((g) => ({ name: g.name, monitorList: g.monitorIds.map((id) => ({ id })) }));
        const res = await emitAck<SimpleAck>(socket, "saveStatusPage", [
          params.slug,
          config,
          (config.icon as string | undefined) ?? "/icon.svg",
          groups,
        ]);
        if (!res.ok) throw new Error(res.msg ?? "save_status_page failed");
        return res;
      });
    },
  };

  return [
    listMonitors,
    getMonitorBeats,
    pauseMonitor,
    resumeMonitor,
    deleteMonitor,
    addHttpMonitor,
    editMonitor,
    listNotifications,
    listMaintenance,
    addMaintenance,
    listStatusPages,
    createStatusPage,
    saveStatusPage,
  ];
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
