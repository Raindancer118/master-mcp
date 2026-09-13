import { z } from "zod";
import type { ActionDef, AnyActionDef, InstanceConfig, ServiceModule } from "../core/types.js";
import { assertOk, makeHttpClient, optionalField, requireField } from "../core/http.js";

const BASE_URL = "https://api.cloudflare.com/client/v4";

interface CloudflareEnvelope<T = unknown> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message: string }>;
  messages?: Array<{ code?: number; message: string }>;
}

/** Builds a fresh axios client authenticated for this instance's API token. */
function clientFor(instance: InstanceConfig) {
  const apiToken = requireField(instance.fields, "apiToken", "Cloudflare");
  return makeHttpClient(BASE_URL, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });
}

/** Asserts HTTP status is 2xx and the Cloudflare envelope reports success, returning `result`. */
function unwrap<T>(status: number, data: CloudflareEnvelope<T>, context: string): T {
  assertOk(status, data, context);
  if (!data.success) {
    const message = (data.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
    throw new Error(message || `${context}: Cloudflare API error`);
  }
  return data.result;
}

/** Strips undefined values from an object so they're omitted from the JSON body/query. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

const listZonesParams = z.object({
  name: z.string().optional(),
  page: z.number().int().positive().optional(),
  perPage: z.number().int().positive().max(50).optional(),
});

const getZoneParams = z.object({
  zoneId: z.string().min(1),
});

const listDnsRecordsParams = z.object({
  zoneId: z.string().min(1),
  type: z.string().optional(),
  name: z.string().optional(),
  page: z.number().int().positive().optional(),
  perPage: z.number().int().positive().max(50).optional(),
});

const createDnsRecordParams = z.object({
  zoneId: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(1),
  ttl: z.number().int().optional(),
  proxied: z.boolean().optional(),
  priority: z.number().int().optional(),
});

const updateDnsRecordParams = z.object({
  zoneId: z.string().min(1),
  recordId: z.string().min(1),
  type: z.string().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
  ttl: z.number().int().optional(),
  proxied: z.boolean().optional(),
});

const deleteDnsRecordParams = z.object({
  zoneId: z.string().min(1),
  recordId: z.string().min(1),
});

const purgeCacheParams = z.object({
  zoneId: z.string().min(1),
  files: z.array(z.string().min(1)).optional(),
  purgeEverything: z.boolean().optional(),
});

const listFirewallRulesParams = z.object({
  zoneId: z.string().min(1),
  page: z.number().int().positive().optional(),
  perPage: z.number().int().positive().max(50).optional(),
});

const getZoneSettingsParams = z.object({
  zoneId: z.string().min(1),
});

const updateZoneSettingParams = z.object({
  zoneId: z.string().min(1),
  settingId: z.string().min(1),
  value: z.unknown(),
});

const listPageRulesParams = z.object({
  zoneId: z.string().min(1),
});

const pageRuleActionParams = z.object({
  id: z.string().min(1),
  value: z.unknown().optional(),
});

const createPageRuleParams = z.object({
  zoneId: z.string().min(1),
  targetUrl: z.string().min(1),
  actions: z.array(pageRuleActionParams).min(1),
  priority: z.number().int().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

const deletePageRuleParams = z.object({
  zoneId: z.string().min(1),
  pageRuleId: z.string().min(1),
});

const listIpAccessRulesParams = z.object({
  zoneId: z.string().min(1),
});

const createIpAccessRuleParams = z.object({
  zoneId: z.string().min(1),
  mode: z.enum(["block", "challenge", "whitelist", "js_challenge"]),
  target: z.enum(["ip", "ip_range", "country", "asn"]),
  value: z.string().min(1),
  notes: z.string().optional(),
});

const deleteIpAccessRuleParams = z.object({
  zoneId: z.string().min(1),
  ruleId: z.string().min(1),
});

const listCertificatePacksParams = z.object({
  zoneId: z.string().min(1),
});

const listCustomHostnamesParams = z.object({
  zoneId: z.string().min(1),
  page: z.number().int().positive().optional(),
  perPage: z.number().int().positive().max(50).optional(),
});

const createCustomHostnameParams = z.object({
  zoneId: z.string().min(1),
  hostname: z.string().min(1),
  sslMethod: z.enum(["http", "txt", "email"]).optional(),
});

const deleteCustomHostnameParams = z.object({
  zoneId: z.string().min(1),
  customHostnameId: z.string().min(1),
});

const listZoneAnalyticsParams = z.object({
  zoneId: z.string().min(1),
  since: z.string().optional(),
  until: z.string().optional(),
});

function buildActions(): AnyActionDef[] {
  const listZones: ActionDef<z.infer<typeof listZonesParams>> = {
    id: "list_zones",
    summary: "List Cloudflare zones (domains) in the account, optionally filtered by name.",
    paramsSchema: listZonesParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/zones", {
        params: compact({
          name: params.name,
          page: params.page,
          per_page: params.perPage ?? 20,
        }),
      });
      return unwrap(res.status, res.data, "list_zones");
    },
  };

  const getZone: ActionDef<z.infer<typeof getZoneParams>> = {
    id: "get_zone",
    summary: "Get details of a single Cloudflare zone by id.",
    paramsSchema: getZoneParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}`);
      return unwrap(res.status, res.data, "get_zone");
    },
  };

  const listDnsRecords: ActionDef<z.infer<typeof listDnsRecordsParams>> = {
    id: "list_dns_records",
    summary: "List DNS records for a Cloudflare zone, optionally filtered by type/name.",
    paramsSchema: listDnsRecordsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}/dns_records`, {
        params: compact({
          type: params.type,
          name: params.name,
          page: params.page,
          per_page: params.perPage ?? 20,
        }),
      });
      return unwrap(res.status, res.data, "list_dns_records");
    },
  };

  const createDnsRecord: ActionDef<z.infer<typeof createDnsRecordParams>> = {
    id: "create_dns_record",
    summary: "Create a new DNS record (A, AAAA, CNAME, TXT, MX, ...) in a Cloudflare zone.",
    paramsSchema: createDnsRecordParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(
        `/zones/${encodeURIComponent(params.zoneId)}/dns_records`,
        compact({
          type: params.type,
          name: params.name,
          content: params.content,
          ttl: params.ttl,
          proxied: params.proxied,
          priority: params.priority,
        })
      );
      return unwrap(res.status, res.data, "create_dns_record");
    },
  };

  const updateDnsRecord: ActionDef<z.infer<typeof updateDnsRecordParams>> = {
    id: "update_dns_record",
    summary: "Update fields of an existing DNS record in a Cloudflare zone.",
    paramsSchema: updateDnsRecordParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.patch(
        `/zones/${encodeURIComponent(params.zoneId)}/dns_records/${encodeURIComponent(params.recordId)}`,
        compact({
          type: params.type,
          name: params.name,
          content: params.content,
          ttl: params.ttl,
          proxied: params.proxied,
        })
      );
      return unwrap(res.status, res.data, "update_dns_record");
    },
  };

  const deleteDnsRecord: ActionDef<z.infer<typeof deleteDnsRecordParams>> = {
    id: "delete_dns_record",
    summary: "Delete a DNS record from a Cloudflare zone. Irreversible.",
    paramsSchema: deleteDnsRecordParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.delete(
        `/zones/${encodeURIComponent(params.zoneId)}/dns_records/${encodeURIComponent(params.recordId)}`
      );
      return unwrap(res.status, res.data, "delete_dns_record");
    },
  };

  const purgeCache: ActionDef<z.infer<typeof purgeCacheParams>> = {
    id: "purge_cache",
    summary: "Purge Cloudflare edge cache for a zone: specific files or everything.",
    paramsSchema: purgeCacheParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const hasFiles = params.files !== undefined && params.files.length > 0;
      const hasPurgeEverything = params.purgeEverything === true;
      if (!hasFiles && !hasPurgeEverything) {
        throw new Error("purge_cache requires either 'files' or 'purgeEverything: true' to be set.");
      }
      if (hasFiles && hasPurgeEverything) {
        throw new Error("purge_cache: specify either 'files' or 'purgeEverything', not both.");
      }
      const client = clientFor(instance);
      const body = hasPurgeEverything ? { purge_everything: true } : { files: params.files };
      const res = await client.post(`/zones/${encodeURIComponent(params.zoneId)}/purge_cache`, body);
      return unwrap(res.status, res.data, "purge_cache");
    },
  };

  const listFirewallRules: ActionDef<z.infer<typeof listFirewallRulesParams>> = {
    id: "list_firewall_rules",
    summary: "List (legacy) firewall rules configured for a Cloudflare zone.",
    paramsSchema: listFirewallRulesParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}/firewall/rules`, {
        params: compact({
          page: params.page,
          per_page: params.perPage ?? 20,
        }),
      });
      return unwrap(res.status, res.data, "list_firewall_rules");
    },
  };

  const getZoneSettings: ActionDef<z.infer<typeof getZoneSettingsParams>> = {
    id: "get_zone_settings",
    summary: "Get all zone settings for a Cloudflare zone (ssl mode, always_online, minify, etc).",
    paramsSchema: getZoneSettingsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}/settings`);
      return unwrap(res.status, res.data, "get_zone_settings");
    },
  };

  const updateZoneSetting: ActionDef<z.infer<typeof updateZoneSettingParams>> = {
    id: "update_zone_setting",
    summary:
      "Update a single zone setting by id, e.g. ssl (off/flexible/full/strict), " +
      "always_use_https (on/off), security_level (essentially_off/low/medium/high/under_attack), " +
      "min_tls_version (1.0/1.1/1.2/1.3), browser_cache_ttl (seconds), development_mode (on/off).",
    paramsSchema: updateZoneSettingParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.patch(
        `/zones/${encodeURIComponent(params.zoneId)}/settings/${encodeURIComponent(params.settingId)}`,
        { value: params.value }
      );
      return unwrap(res.status, res.data, "update_zone_setting");
    },
  };

  const listPageRules: ActionDef<z.infer<typeof listPageRulesParams>> = {
    id: "list_page_rules",
    summary: "List page rules configured for a Cloudflare zone.",
    paramsSchema: listPageRulesParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}/pagerules`);
      return unwrap(res.status, res.data, "list_page_rules");
    },
  };

  const createPageRule: ActionDef<z.infer<typeof createPageRuleParams>> = {
    id: "create_page_rule",
    summary: "Create a page rule matching a target URL pattern with one or more actions.",
    paramsSchema: createPageRuleParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/zones/${encodeURIComponent(params.zoneId)}/pagerules`, {
        targets: [{ target: "url", constraint: { operator: "matches", value: params.targetUrl } }],
        actions: params.actions,
        priority: params.priority,
        status: params.status ?? "active",
      });
      return unwrap(res.status, res.data, "create_page_rule");
    },
  };

  const deletePageRule: ActionDef<z.infer<typeof deletePageRuleParams>> = {
    id: "delete_page_rule",
    summary: "Delete a page rule from a Cloudflare zone. Irreversible.",
    paramsSchema: deletePageRuleParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.delete(
        `/zones/${encodeURIComponent(params.zoneId)}/pagerules/${encodeURIComponent(params.pageRuleId)}`
      );
      return unwrap(res.status, res.data, "delete_page_rule");
    },
  };

  const listIpAccessRules: ActionDef<z.infer<typeof listIpAccessRulesParams>> = {
    id: "list_ip_access_rules",
    summary: "List IP/country/ASN access rules (block/challenge/whitelist) for a Cloudflare zone.",
    paramsSchema: listIpAccessRulesParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}/firewall/access_rules/rules`);
      return unwrap(res.status, res.data, "list_ip_access_rules");
    },
  };

  const createIpAccessRule: ActionDef<z.infer<typeof createIpAccessRuleParams>> = {
    id: "create_ip_access_rule",
    summary: "Create an IP/IP-range/country/ASN access rule (block, challenge, whitelist, js_challenge).",
    paramsSchema: createIpAccessRuleParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/zones/${encodeURIComponent(params.zoneId)}/firewall/access_rules/rules`, {
        mode: params.mode,
        configuration: { target: params.target, value: params.value },
        notes: params.notes,
      });
      return unwrap(res.status, res.data, "create_ip_access_rule");
    },
  };

  const deleteIpAccessRule: ActionDef<z.infer<typeof deleteIpAccessRuleParams>> = {
    id: "delete_ip_access_rule",
    summary: "Delete an IP access rule from a Cloudflare zone. Irreversible.",
    paramsSchema: deleteIpAccessRuleParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.delete(
        `/zones/${encodeURIComponent(params.zoneId)}/firewall/access_rules/rules/${encodeURIComponent(params.ruleId)}`
      );
      return unwrap(res.status, res.data, "delete_ip_access_rule");
    },
  };

  const listCertificatePacks: ActionDef<z.infer<typeof listCertificatePacksParams>> = {
    id: "list_certificate_packs",
    summary: "List SSL/TLS certificate packs for a Cloudflare zone.",
    paramsSchema: listCertificatePacksParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}/ssl/certificate_packs`);
      return unwrap(res.status, res.data, "list_certificate_packs");
    },
  };

  const listCustomHostnames: ActionDef<z.infer<typeof listCustomHostnamesParams>> = {
    id: "list_custom_hostnames",
    summary: "List custom hostnames (SSL for SaaS) configured for a Cloudflare zone.",
    paramsSchema: listCustomHostnamesParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}/custom_hostnames`, {
        params: compact({
          page: params.page,
          per_page: params.perPage ?? 20,
        }),
      });
      return unwrap(res.status, res.data, "list_custom_hostnames");
    },
  };

  const createCustomHostname: ActionDef<z.infer<typeof createCustomHostnameParams>> = {
    id: "create_custom_hostname",
    summary: "Create a custom hostname (SSL for SaaS) on a Cloudflare zone.",
    paramsSchema: createCustomHostnameParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/zones/${encodeURIComponent(params.zoneId)}/custom_hostnames`, {
        hostname: params.hostname,
        ssl: { method: params.sslMethod ?? "http", type: "dv" },
      });
      return unwrap(res.status, res.data, "create_custom_hostname");
    },
  };

  const deleteCustomHostname: ActionDef<z.infer<typeof deleteCustomHostnameParams>> = {
    id: "delete_custom_hostname",
    summary: "Delete a custom hostname (SSL for SaaS) from a Cloudflare zone. Irreversible.",
    paramsSchema: deleteCustomHostnameParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.delete(
        `/zones/${encodeURIComponent(params.zoneId)}/custom_hostnames/${encodeURIComponent(params.customHostnameId)}`
      );
      return unwrap(res.status, res.data, "delete_custom_hostname");
    },
  };

  const listZoneAnalytics: ActionDef<z.infer<typeof listZoneAnalyticsParams>> = {
    id: "list_zone_analytics",
    summary: "Get zone analytics dashboard totals (requests, bandwidth, threats) for a date range.",
    paramsSchema: listZoneAnalyticsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/zones/${encodeURIComponent(params.zoneId)}/analytics/dashboard`, {
        params: compact({
          since: params.since,
          until: params.until,
        }),
      });
      return unwrap(res.status, res.data, "list_zone_analytics");
    },
  };

  return [
    listZones,
    getZone,
    listDnsRecords,
    createDnsRecord,
    updateDnsRecord,
    deleteDnsRecord,
    purgeCache,
    listFirewallRules,
    getZoneSettings,
    updateZoneSetting,
    listPageRules,
    createPageRule,
    deletePageRule,
    listIpAccessRules,
    createIpAccessRule,
    deleteIpAccessRule,
    listCertificatePacks,
    listCustomHostnames,
    createCustomHostname,
    deleteCustomHostname,
    listZoneAnalytics,
  ];
}

const cloudflareService: ServiceModule = {
  id: "cloudflare",
  label: "Cloudflare",
  description: "Cloudflare DNS/zone/cache administration via the REST API v4 (API Token auth).",
  parseInstanceFields: (fields) => {
    const apiToken = requireField(fields, "apiToken", "Cloudflare");
    const accountId = optionalField(fields, "accountId");
    return compact({ apiToken, accountId });
  },
  exampleFields: ["API_TOKEN", "ACCOUNT_ID"],
  buildActions,
};

export default cloudflareService;
