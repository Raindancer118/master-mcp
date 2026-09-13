import { z } from "zod";
import type { ActionDef, AnyActionDef, InstanceConfig, ServiceModule } from "../core/types.js";
import { requireField, optionalField, makeHttpClient, assertOk } from "../core/http.js";

interface NpmErrorBody {
  error?: { code?: number; message?: string };
}

function baseUrlOf(instance: InstanceConfig): string {
  return requireField(instance.fields, "baseUrl", "NPM").replace(/\/+$/, "");
}

function insecureTlsOf(instance: InstanceConfig): boolean {
  return instance.fields.insecureTls === "true";
}

function extractErrorMessage(data: unknown): string | undefined {
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as NpmErrorBody).error;
    if (err?.message) return err.message;
  }
  return undefined;
}

/** Extracts the value of one cookie from a Set-Cookie response header list, ignoring
 * attributes (Path, Secure, HttpOnly, ...). Returns "name=value" suitable for a Cookie header. */
function extractSetCookie(setCookieHeaders: string[] | undefined, cookieName: string): string | undefined {
  if (!setCookieHeaders) return undefined;
  for (const header of setCookieHeaders) {
    const pair = header.split(";", 1)[0] ?? "";
    const name = pair.split("=", 1)[0];
    if (name === cookieName) return pair;
  }
  return undefined;
}

/** Logs in fresh against the NPM/NPMPlus API and returns the auth header to use for
 * subsequent requests. No caching - this is an admin tool used occasionally, not a
 * high-throughput client, and tokens are short-lived.
 *
 * Upstream NPM (jc21) returns the token in the response body -> Authorization: Bearer.
 * The NPMPlus fork (zoeyvid) instead sets it as an HttpOnly `__Host-Http-token` cookie
 * and rejects Bearer auth entirely -> Cookie header. Both are tried so one module covers
 * both forks. */
async function getAuthHeader(instance: InstanceConfig): Promise<Record<string, string>> {
  const client = makeHttpClient(`${baseUrlOf(instance)}/api`, { insecureTls: insecureTlsOf(instance) });
  const res = await client.post("/tokens", {
    identity: instance.fields.identity,
    secret: instance.fields.secret,
  });
  const message = extractErrorMessage(res.data);
  if (message) {
    throw new Error(`Nginx Proxy Manager login failed: ${message}`);
  }
  assertOk(res.status, res.data, "Nginx Proxy Manager login");
  const token = (res.data as { token?: string }).token;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  const setCookie = res.headers["set-cookie"] as string[] | undefined;
  const cookie = extractSetCookie(setCookie, "__Host-Http-token");
  if (cookie) {
    return { Cookie: cookie };
  }
  throw new Error("Nginx Proxy Manager login succeeded but no token (body or __Host-Http-token cookie) was returned");
}

async function npmRequest(
  instance: InstanceConfig,
  method: "get" | "post" | "put" | "delete",
  path: string,
  opts: { data?: unknown; params?: Record<string, unknown> } = {}
): Promise<unknown> {
  const authHeader = await getAuthHeader(instance);
  const client = makeHttpClient(`${baseUrlOf(instance)}/api`, {
    insecureTls: insecureTlsOf(instance),
    headers: authHeader,
  });
  const res = await client.request({ method, url: path, data: opts.data, params: opts.params });
  const message = extractErrorMessage(res.data);
  if (message) {
    throw new Error(`Nginx Proxy Manager ${method.toUpperCase()} ${path} failed: ${message}`);
  }
  assertOk(res.status, res.data, `Nginx Proxy Manager ${method.toUpperCase()} ${path}`);
  return res.data;
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const proxyHostCoreFields = {
  domainNames: z.array(z.string()).optional(),
  forwardHost: z.string().optional(),
  forwardPort: z.number().optional(),
  forwardScheme: z.enum(["http", "https"]).optional(),
  sslForced: z.boolean().optional(),
  cachingEnabled: z.boolean().optional(),
  blockExploits: z.boolean().optional(),
  allowWebsocketUpgrade: z.boolean().optional(),
  http2Support: z.boolean().optional(),
  certificateId: z.number().optional(),
  accessListId: z.number().optional(),
  advancedConfig: z.string().optional(),
};

function proxyHostToNpmBody(params: {
  domainNames?: string[];
  forwardHost?: string;
  forwardPort?: number;
  forwardScheme?: "http" | "https";
  sslForced?: boolean;
  cachingEnabled?: boolean;
  blockExploits?: boolean;
  allowWebsocketUpgrade?: boolean;
  http2Support?: boolean;
  certificateId?: number;
  accessListId?: number;
  advancedConfig?: string;
}): Record<string, unknown> {
  return pruneUndefined({
    domain_names: params.domainNames,
    forward_scheme: params.forwardScheme,
    forward_host: params.forwardHost,
    forward_port: params.forwardPort,
    ssl_forced: params.sslForced,
    caching_enabled: params.cachingEnabled,
    block_exploits: params.blockExploits,
    allow_websocket_upgrade: params.allowWebsocketUpgrade,
    http2_support: params.http2Support,
    certificate_id: params.certificateId,
    access_list_id: params.accessListId,
    advanced_config: params.advancedConfig,
  });
}

const listProxyHostsAction: ActionDef<Record<string, never>, unknown> = {
  id: "list_proxy_hosts",
  summary: "List all Nginx Proxy Manager / NPMPlus proxy hosts, with owner/access-list/certificate details when supported",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => {
    try {
      return await npmRequest(instance, "get", "/nginx/proxy-hosts", {
        params: { expand: "owner,access_list,certificate" },
      });
    } catch (err) {
      // Some NPMPlus builds 500 on the `expand` query param (server-side bug, confirmed against
      // a real instance). Fall back to the unexpanded list rather than losing the whole call.
      if (err instanceof Error && /Internal Error/i.test(err.message)) {
        return npmRequest(instance, "get", "/nginx/proxy-hosts");
      }
      throw err;
    }
  },
};

const createProxyHostParams = z.object({
  domainNames: z.array(z.string()),
  forwardHost: z.string(),
  forwardPort: z.number(),
  forwardScheme: z.enum(["http", "https"]).optional(),
  sslForced: z.boolean().optional(),
  cachingEnabled: z.boolean().optional(),
  blockExploits: z.boolean().optional(),
  allowWebsocketUpgrade: z.boolean().optional(),
  http2Support: z.boolean().optional(),
  certificateId: z.number().optional(),
  accessListId: z.number().optional(),
  advancedConfig: z.string().optional(),
});

const createProxyHostAction: ActionDef<z.infer<typeof createProxyHostParams>, unknown> = {
  id: "create_proxy_host",
  summary: "Create a new reverse proxy host - domain(s) -> forward target, with SSL/caching/security options",
  paramsSchema: createProxyHostParams,
  readOnly: false,
  destructive: false,
  handler: async (params, instance) =>
    npmRequest(instance, "post", "/nginx/proxy-hosts", {
      data: {
        domain_names: params.domainNames,
        forward_scheme: params.forwardScheme ?? "http",
        forward_host: params.forwardHost,
        forward_port: params.forwardPort,
        ssl_forced: params.sslForced ?? false,
        caching_enabled: params.cachingEnabled ?? false,
        block_exploits: params.blockExploits ?? false,
        allow_websocket_upgrade: params.allowWebsocketUpgrade ?? true,
        http2_support: params.http2Support ?? false,
        certificate_id: params.certificateId ?? 0,
        access_list_id: params.accessListId ?? 0,
        advanced_config: params.advancedConfig ?? "",
        meta: {},
      },
    }),
};

const updateProxyHostParams = z.object({
  hostId: z.number(),
  ...proxyHostCoreFields,
});

const updateProxyHostAction: ActionDef<z.infer<typeof updateProxyHostParams>, unknown> = {
  id: "update_proxy_host",
  summary: "Update an existing proxy host's forward target, domains, SSL or security settings (partial update)",
  paramsSchema: updateProxyHostParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) =>
    npmRequest(instance, "put", `/nginx/proxy-hosts/${params.hostId}`, { data: proxyHostToNpmBody(params) }),
};

const hostIdParams = z.object({ hostId: z.number() });

const deleteProxyHostAction: ActionDef<z.infer<typeof hostIdParams>, unknown> = {
  id: "delete_proxy_host",
  summary: "Delete a proxy host permanently - irreversible",
  paramsSchema: hostIdParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) => npmRequest(instance, "delete", `/nginx/proxy-hosts/${params.hostId}`),
};

const enableProxyHostAction: ActionDef<z.infer<typeof hostIdParams>, unknown> = {
  id: "enable_proxy_host",
  summary: "Enable a disabled proxy host",
  paramsSchema: hostIdParams,
  readOnly: false,
  destructive: false,
  handler: async (params, instance) => npmRequest(instance, "post", `/nginx/proxy-hosts/${params.hostId}/enable`),
};

const disableProxyHostAction: ActionDef<z.infer<typeof hostIdParams>, unknown> = {
  id: "disable_proxy_host",
  summary: "Disable a proxy host - takes the forwarded site offline via this proxy",
  paramsSchema: hostIdParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) => npmRequest(instance, "post", `/nginx/proxy-hosts/${params.hostId}/disable`),
};

const listRedirectionHostsAction: ActionDef<Record<string, never>, unknown> = {
  id: "list_redirection_hosts",
  summary: "List all configured redirection hosts (domain redirects)",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => npmRequest(instance, "get", "/nginx/redirection-hosts"),
};

const listStreamsAction: ActionDef<Record<string, never>, unknown> = {
  id: "list_streams",
  summary: "List all configured TCP/UDP streams",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => npmRequest(instance, "get", "/nginx/streams"),
};

const listAccessListsAction: ActionDef<Record<string, never>, unknown> = {
  id: "list_access_lists",
  summary: "List all configured access lists (basic auth / allow-deny rules)",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => npmRequest(instance, "get", "/nginx/access-lists"),
};

const listCertificatesAction: ActionDef<Record<string, never>, unknown> = {
  id: "list_certificates",
  summary: "List all SSL certificates known to Nginx Proxy Manager / NPMPlus",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => npmRequest(instance, "get", "/nginx/certificates"),
};

const listUsersAction: ActionDef<Record<string, never>, unknown> = {
  id: "list_users",
  summary: "List all Nginx Proxy Manager / NPMPlus users",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => npmRequest(instance, "get", "/users"),
};

const createUserParams = z.object({
  name: z.string(),
  nickname: z.string(),
  email: z.string(),
  password: z.string(),
  isAdmin: z.boolean().optional(),
});

const createUserAction: ActionDef<z.infer<typeof createUserParams>, unknown> = {
  id: "create_user",
  summary: "Create a new NPM user and set their password (two-step: create user, then set auth)",
  paramsSchema: createUserParams,
  readOnly: false,
  destructive: false,
  handler: async (params, instance) => {
    const user = await npmRequest(instance, "post", "/users", {
      data: {
        name: params.name,
        nickname: params.nickname,
        email: params.email,
        roles: params.isAdmin ? ["admin"] : [],
        is_disabled: false,
      },
    });
    const userId = (user as { id?: number })?.id;
    const auth = await npmRequest(instance, "post", `/users/${userId}/auth`, {
      data: { type: "password", secret: params.password },
    });
    return { user, auth };
  },
};

const updateUserParams = z.object({
  userId: z.number(),
  name: z.string().optional(),
  nickname: z.string().optional(),
  email: z.string().optional(),
  isAdmin: z.boolean().optional(),
  isDisabled: z.boolean().optional(),
});

const updateUserAction: ActionDef<z.infer<typeof updateUserParams>, unknown> = {
  id: "update_user",
  summary: "Update an existing NPM user's name, nickname, email, admin role or disabled state (partial update)",
  paramsSchema: updateUserParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) =>
    npmRequest(instance, "put", `/users/${params.userId}`, {
      data: pruneUndefined({
        name: params.name,
        nickname: params.nickname,
        email: params.email,
        roles: params.isAdmin === undefined ? undefined : params.isAdmin ? ["admin"] : [],
        is_disabled: params.isDisabled,
      }),
    }),
};

const userIdParams = z.object({ userId: z.number() });

const deleteUserAction: ActionDef<z.infer<typeof userIdParams>, unknown> = {
  id: "delete_user",
  summary: "Delete an NPM user permanently - irreversible",
  paramsSchema: userIdParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) => npmRequest(instance, "delete", `/users/${params.userId}`),
};

const listDeadHostsAction: ActionDef<Record<string, never>, unknown> = {
  id: "list_dead_hosts",
  summary: "List all configured 404/catch-all (dead) hosts",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => npmRequest(instance, "get", "/nginx/dead-hosts"),
};

const listSettingsAction: ActionDef<Record<string, never>, unknown> = {
  id: "list_settings",
  summary: "List all NPM/NPMPlus application settings",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => npmRequest(instance, "get", "/settings"),
};

const updateSettingParams = z.object({
  settingId: z.string(),
  value: z.unknown(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const updateSettingAction: ActionDef<z.infer<typeof updateSettingParams>, unknown> = {
  id: "update_setting",
  summary: "Update an application setting by id (e.g. default-site)",
  paramsSchema: updateSettingParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) =>
    npmRequest(instance, "put", `/settings/${params.settingId}`, {
      data: { value: params.value, meta: params.meta ?? {} },
    }),
};

const requestLetsencryptCertificateParams = z.object({
  domainNames: z.array(z.string()),
  email: z.string(),
  agreeTos: z.boolean().optional(),
});

const requestLetsencryptCertificateAction: ActionDef<
  z.infer<typeof requestLetsencryptCertificateParams>,
  unknown
> = {
  id: "request_letsencrypt_certificate",
  summary: "Request a new Let's Encrypt SSL certificate for one or more domains",
  paramsSchema: requestLetsencryptCertificateParams,
  readOnly: false,
  destructive: false,
  handler: async (params, instance) =>
    npmRequest(instance, "post", "/nginx/certificates", {
      data: {
        provider: "letsencrypt",
        domain_names: params.domainNames,
        meta: {
          letsencrypt_email: params.email,
          letsencrypt_agree: params.agreeTos ?? true,
          dns_challenge: false,
        },
      },
    }),
};

const certificateIdParams = z.object({ certificateId: z.number() });

const deleteCertificateAction: ActionDef<z.infer<typeof certificateIdParams>, unknown> = {
  id: "delete_certificate",
  summary: "Delete an SSL certificate permanently - irreversible",
  paramsSchema: certificateIdParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) => npmRequest(instance, "delete", `/nginx/certificates/${params.certificateId}`),
};

const npmService: ServiceModule = {
  id: "npm",
  label: "Nginx Proxy Manager / NPMPlus",
  description:
    "Nginx Proxy Manager and the API-compatible NPMPlus fork - reverse proxy hosts, redirection hosts, streams, access lists, certificates",
  parseInstanceFields: (fields) => {
    requireField(fields, "baseUrl", "Nginx Proxy Manager / NPMPlus");
    requireField(fields, "identity", "Nginx Proxy Manager / NPMPlus");
    requireField(fields, "secret", "Nginx Proxy Manager / NPMPlus");
    const insecureTls = optionalField(fields, "insecureTls", "false");
    return { ...fields, insecureTls: insecureTls === "true" ? "true" : "false" };
  },
  exampleFields: ["BASE_URL", "IDENTITY", "SECRET", "INSECURE_TLS"],
  buildActions: (): AnyActionDef[] => [
    listProxyHostsAction,
    createProxyHostAction,
    updateProxyHostAction,
    deleteProxyHostAction,
    enableProxyHostAction,
    disableProxyHostAction,
    listRedirectionHostsAction,
    listStreamsAction,
    listAccessListsAction,
    listCertificatesAction,
    listUsersAction,
    createUserAction,
    updateUserAction,
    deleteUserAction,
    listDeadHostsAction,
    listSettingsAction,
    updateSettingAction,
    requestLetsencryptCertificateAction,
    deleteCertificateAction,
  ],
};

export default npmService;
