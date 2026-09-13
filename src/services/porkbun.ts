import { z } from "zod";
import type { ActionDef, AnyActionDef, InstanceConfig, ServiceModule } from "../core/types.js";
import { requireField, makeHttpClient, assertOk } from "../core/http.js";

const BASE_URL = "https://api.porkbun.com/api/json/v3";

interface PorkbunResponse {
  status: string;
  message?: string;
  [key: string]: unknown;
}

async function porkbunPost(
  instance: InstanceConfig,
  path: string,
  extra: Record<string, unknown> = {}
): Promise<PorkbunResponse> {
  const client = makeHttpClient(BASE_URL);
  const body = {
    apikey: instance.fields.apiKey,
    secretapikey: instance.fields.secretApiKey,
    ...extra,
  };
  const res = await client.post(path, body);
  assertOk(res.status, res.data, `Porkbun ${path}`);
  const data = res.data as PorkbunResponse;
  if (data.status !== "SUCCESS") {
    throw new Error(data.message ?? `Porkbun ${path} returned status ${data.status}`);
  }
  return data;
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const pingAction: ActionDef<Record<string, never>, PorkbunResponse> = {
  id: "ping",
  summary: "Check Porkbun API connectivity and return the caller's public IP - good smoke test",
  paramsSchema: z.object({}),
  readOnly: true,
  destructive: false,
  handler: async (_params, instance) => porkbunPost(instance, "/ping"),
};

const listDomainsParams = z.object({
  start: z.number().optional(),
  includeLabels: z.enum(["yes", "no"]).optional(),
});

const listDomainsAction: ActionDef<z.infer<typeof listDomainsParams>, PorkbunResponse> = {
  id: "list_domains",
  summary: "List all domains in the Porkbun account, with pagination and optional labels",
  paramsSchema: listDomainsParams,
  readOnly: true,
  destructive: false,
  handler: async (params, instance) =>
    porkbunPost(instance, "/domain/listAll", pruneUndefined({ start: params.start, includeLabels: params.includeLabels })),
};

const getDnsRecordsParams = z.object({
  domain: z.string(),
  recordId: z.string().optional(),
  type: z.string().optional(),
  subdomain: z.string().optional(),
});

const getDnsRecordsAction: ActionDef<z.infer<typeof getDnsRecordsParams>, PorkbunResponse> = {
  id: "get_dns_records",
  summary: "Retrieve DNS records for a domain - by record id, by type+subdomain, or all records",
  paramsSchema: getDnsRecordsParams,
  readOnly: true,
  destructive: false,
  handler: async (params, instance) => {
    if (params.recordId) {
      return porkbunPost(instance, `/dns/retrieve/${params.domain}/${params.recordId}`);
    }
    if (params.type !== undefined && params.subdomain !== undefined) {
      return porkbunPost(instance, `/dns/retrieveByNameType/${params.domain}/${params.type}/${params.subdomain}`);
    }
    return porkbunPost(instance, `/dns/retrieve/${params.domain}`);
  },
};

const createDnsRecordParams = z.object({
  domain: z.string(),
  type: z.string(),
  name: z.string().optional(),
  content: z.string(),
  ttl: z.string().optional(),
  prio: z.string().optional(),
});

const createDnsRecordAction: ActionDef<z.infer<typeof createDnsRecordParams>, PorkbunResponse> = {
  id: "create_dns_record",
  summary: "Create a new DNS record (A, AAAA, CNAME, MX, TXT, ...) for a domain",
  paramsSchema: createDnsRecordParams,
  readOnly: false,
  destructive: false,
  handler: async (params, instance) =>
    porkbunPost(
      instance,
      `/dns/create/${params.domain}`,
      pruneUndefined({ type: params.type, name: params.name, content: params.content, ttl: params.ttl, prio: params.prio })
    ),
};

const editDnsRecordParams = z.object({
  domain: z.string(),
  recordId: z.string(),
  type: z.string(),
  content: z.string(),
  name: z.string().optional(),
  ttl: z.string().optional(),
  prio: z.string().optional(),
});

const editDnsRecordAction: ActionDef<z.infer<typeof editDnsRecordParams>, PorkbunResponse> = {
  id: "edit_dns_record",
  summary: "Edit an existing DNS record by id - change type, name, content, ttl or priority",
  paramsSchema: editDnsRecordParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) =>
    porkbunPost(
      instance,
      `/dns/edit/${params.domain}/${params.recordId}`,
      pruneUndefined({ type: params.type, name: params.name, content: params.content, ttl: params.ttl, prio: params.prio })
    ),
};

const deleteDnsRecordParams = z.object({
  domain: z.string(),
  recordId: z.string(),
});

const deleteDnsRecordAction: ActionDef<z.infer<typeof deleteDnsRecordParams>, PorkbunResponse> = {
  id: "delete_dns_record",
  summary: "Delete a DNS record by id - irreversible",
  paramsSchema: deleteDnsRecordParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) => porkbunPost(instance, `/dns/delete/${params.domain}/${params.recordId}`),
};

const updateNameserversParams = z.object({
  domain: z.string(),
  nameservers: z.array(z.string()),
});

const updateNameserversAction: ActionDef<z.infer<typeof updateNameserversParams>, PorkbunResponse> = {
  id: "update_nameservers",
  summary: "Update the authoritative nameservers for a domain - affects DNS resolution globally",
  paramsSchema: updateNameserversParams,
  readOnly: false,
  destructive: true,
  handler: async (params, instance) => porkbunPost(instance, `/domain/updateNs/${params.domain}`, { ns: params.nameservers }),
};

const getSslBundleParams = z.object({
  domain: z.string(),
});

const getSslBundleAction: ActionDef<z.infer<typeof getSslBundleParams>, PorkbunResponse> = {
  id: "get_ssl_bundle",
  summary: "Retrieve the free SSL certificate bundle (certificate chain, private key, public key) for a domain",
  paramsSchema: getSslBundleParams,
  readOnly: true,
  destructive: false,
  handler: async (params, instance) => porkbunPost(instance, `/ssl/retrieve/${params.domain}`),
};

const porkbunService: ServiceModule = {
  id: "porkbun",
  label: "Porkbun",
  description: "Porkbun domain registrar - DNS records, nameservers, domain listing, SSL bundles",
  parseInstanceFields: (fields) => {
    requireField(fields, "apiKey", "Porkbun");
    requireField(fields, "secretApiKey", "Porkbun");
    return fields;
  },
  exampleFields: ["API_KEY", "SECRET_API_KEY"],
  buildActions: (): AnyActionDef[] => [
    pingAction,
    listDomainsAction,
    getDnsRecordsAction,
    createDnsRecordAction,
    editDnsRecordAction,
    deleteDnsRecordAction,
    updateNameserversAction,
    getSslBundleAction,
  ],
};

export default porkbunService;
