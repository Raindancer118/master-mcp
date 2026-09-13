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

  return [
    listZones,
    getZone,
    listDnsRecords,
    createDnsRecord,
    updateDnsRecord,
    deleteDnsRecord,
    purgeCache,
    listFirewallRules,
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
