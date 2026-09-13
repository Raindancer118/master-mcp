import { z } from "zod";
import type { ActionDef, AnyActionDef, InstanceConfig, ServiceModule } from "../core/types.js";
import { assertOk, makeHttpClient, optionalField, requireField } from "../core/http.js";

const API_PREFIX = "/api/v1";

/** Builds a fresh axios client authenticated for this instance, scoped to the API v1 base path. */
function clientFor(instance: InstanceConfig) {
  const baseUrl = requireField(instance.fields, "baseUrl", "Coolify");
  const apiToken = requireField(instance.fields, "apiToken", "Coolify");
  const insecureTls = instance.fields.insecureTls === "true";
  return makeHttpClient(`${baseUrl.replace(/\/+$/, "")}${API_PREFIX}`, {
    insecureTls,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });
}

/** Extracts a `.message` string from a Coolify error body, if present. */
function extractMessage(data: unknown): string | undefined {
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

/** Asserts HTTP status is 2xx, enriching the error with the API's `.message` field when present. */
function checkOk(status: number, data: unknown, context: string): void {
  if (status < 200 || status >= 300) {
    const message = extractMessage(data);
    if (message) {
      throw new Error(`${context} failed with HTTP ${status}: ${message}`);
    }
    assertOk(status, data, context);
  }
}

/** Strips undefined values from an object so they're omitted from the JSON body/query. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

const uuidParams = z.object({ uuid: z.string().min(1) });

const deployParams = z.object({
  uuid: z.string().optional(),
  tag: z.string().optional(),
  force: z.boolean().optional(),
  pr: z.number().int().optional(),
});

const applicationLogsParams = z.object({
  uuid: z.string().min(1),
  lines: z.number().int().positive().optional(),
});

const createEnvParams = z.object({
  uuid: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
  isPreview: z.boolean().optional(),
  isBuildTime: z.boolean().optional(),
  isLiteral: z.boolean().optional(),
});

const deleteEnvParams = z.object({
  uuid: z.string().min(1),
  key: z.string().min(1),
});

function buildActions(): AnyActionDef[] {
  // ---- Applications ---------------------------------------------------------
  const listApplications: ActionDef<Record<string, never>> = {
    id: "list_applications",
    summary: "List all Coolify applications across every project/server.",
    paramsSchema: z.object({}),
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/applications");
      checkOk(res.status, res.data, "list_applications");
      return res.data;
    },
  };

  const getApplication: ActionDef<z.infer<typeof uuidParams>> = {
    id: "get_application",
    summary: "Get full details of one Coolify application by uuid.",
    paramsSchema: uuidParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/applications/${params.uuid}`);
      checkOk(res.status, res.data, "get_application");
      return res.data;
    },
  };

  const startApplication: ActionDef<z.infer<typeof uuidParams>> = {
    id: "start_application",
    summary: "Start a stopped Coolify application.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/applications/${params.uuid}/start`);
      checkOk(res.status, res.data, "start_application");
      return res.data;
    },
  };

  const stopApplication: ActionDef<z.infer<typeof uuidParams>> = {
    id: "stop_application",
    summary: "Stop a running Coolify application.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/applications/${params.uuid}/stop`);
      checkOk(res.status, res.data, "stop_application");
      return res.data;
    },
  };

  const restartApplication: ActionDef<z.infer<typeof uuidParams>> = {
    id: "restart_application",
    summary: "Restart a Coolify application.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/applications/${params.uuid}/restart`);
      checkOk(res.status, res.data, "restart_application");
      return res.data;
    },
  };

  const deploy: ActionDef<z.infer<typeof deployParams>> = {
    id: "deploy",
    summary: "Trigger a deployment by application/resource uuid or tag, optionally forcing a no-cache rebuild.",
    paramsSchema: deployParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      if (!params.uuid && !params.tag) {
        throw new Error("deploy requires either uuid or tag");
      }
      const client = clientFor(instance);
      const res = await client.post(
        "/deploy",
        {},
        {
          params: compact({ uuid: params.uuid, tag: params.tag, force: params.force, pr: params.pr }),
        }
      );
      checkOk(res.status, res.data, "deploy");
      return res.data;
    },
  };

  const getApplicationLogs: ActionDef<z.infer<typeof applicationLogsParams>> = {
    id: "get_application_logs",
    summary: "Get recent logs for a Coolify application.",
    paramsSchema: applicationLogsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/applications/${params.uuid}/logs`, {
        params: compact({ lines: params.lines }),
      });
      checkOk(res.status, res.data, "get_application_logs");
      return res.data;
    },
  };

  const listApplicationEnvs: ActionDef<z.infer<typeof uuidParams>> = {
    id: "list_application_envs",
    summary: "List environment variables configured for a Coolify application.",
    paramsSchema: uuidParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/applications/${params.uuid}/envs`);
      checkOk(res.status, res.data, "list_application_envs");
      return res.data;
    },
  };

  const createApplicationEnv: ActionDef<z.infer<typeof createEnvParams>> = {
    id: "create_application_env",
    summary: "Create or update an environment variable on a Coolify application.",
    paramsSchema: createEnvParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/applications/${params.uuid}/envs`, {
        key: params.key,
        value: params.value,
        is_preview: params.isPreview ?? false,
        is_build_time: params.isBuildTime ?? false,
        is_literal: params.isLiteral ?? false,
      });
      checkOk(res.status, res.data, "create_application_env");
      return res.data;
    },
  };

  const deleteApplicationEnv: ActionDef<z.infer<typeof deleteEnvParams>> = {
    id: "delete_application_env",
    summary: "Delete an environment variable from a Coolify application by key.",
    paramsSchema: deleteEnvParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.delete(`/applications/${params.uuid}/envs`, {
        data: { key: params.key },
      });
      checkOk(res.status, res.data, "delete_application_env");
      return res.data;
    },
  };

  // ---- Deployments ------------------------------------------------------------
  const listDeployments: ActionDef<Record<string, never>> = {
    id: "list_deployments",
    summary: "List currently running/queued Coolify deployments.",
    paramsSchema: z.object({}),
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/deployments");
      checkOk(res.status, res.data, "list_deployments");
      return res.data;
    },
  };

  const getDeployment: ActionDef<z.infer<typeof uuidParams>> = {
    id: "get_deployment",
    summary: "Get details/status of one Coolify deployment by uuid.",
    paramsSchema: uuidParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/deployments/${params.uuid}`);
      checkOk(res.status, res.data, "get_deployment");
      return res.data;
    },
  };

  // ---- Databases ----------------------------------------------------------
  const listDatabases: ActionDef<Record<string, never>> = {
    id: "list_databases",
    summary: "List all Coolify-managed databases.",
    paramsSchema: z.object({}),
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/databases");
      checkOk(res.status, res.data, "list_databases");
      return res.data;
    },
  };

  const getDatabase: ActionDef<z.infer<typeof uuidParams>> = {
    id: "get_database",
    summary: "Get full details of one Coolify database by uuid.",
    paramsSchema: uuidParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/databases/${params.uuid}`);
      checkOk(res.status, res.data, "get_database");
      return res.data;
    },
  };

  const startDatabase: ActionDef<z.infer<typeof uuidParams>> = {
    id: "start_database",
    summary: "Start a stopped Coolify database.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/databases/${params.uuid}/start`);
      checkOk(res.status, res.data, "start_database");
      return res.data;
    },
  };

  const stopDatabase: ActionDef<z.infer<typeof uuidParams>> = {
    id: "stop_database",
    summary: "Stop a running Coolify database.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/databases/${params.uuid}/stop`);
      checkOk(res.status, res.data, "stop_database");
      return res.data;
    },
  };

  const restartDatabase: ActionDef<z.infer<typeof uuidParams>> = {
    id: "restart_database",
    summary: "Restart a Coolify database.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/databases/${params.uuid}/restart`);
      checkOk(res.status, res.data, "restart_database");
      return res.data;
    },
  };

  // ---- Services (one-click app stacks) -----------------------------------
  const listServices: ActionDef<Record<string, never>> = {
    id: "list_services",
    summary: "List all Coolify services (one-click app stacks like Plausible, Ghost, etc).",
    paramsSchema: z.object({}),
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/services");
      checkOk(res.status, res.data, "list_services");
      return res.data;
    },
  };

  const getService: ActionDef<z.infer<typeof uuidParams>> = {
    id: "get_service",
    summary: "Get full details of one Coolify service by uuid.",
    paramsSchema: uuidParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/services/${params.uuid}`);
      checkOk(res.status, res.data, "get_service");
      return res.data;
    },
  };

  const startService: ActionDef<z.infer<typeof uuidParams>> = {
    id: "start_service",
    summary: "Start a stopped Coolify service.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/services/${params.uuid}/start`);
      checkOk(res.status, res.data, "start_service");
      return res.data;
    },
  };

  const stopService: ActionDef<z.infer<typeof uuidParams>> = {
    id: "stop_service",
    summary: "Stop a running Coolify service.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/services/${params.uuid}/stop`);
      checkOk(res.status, res.data, "stop_service");
      return res.data;
    },
  };

  const restartService: ActionDef<z.infer<typeof uuidParams>> = {
    id: "restart_service",
    summary: "Restart a Coolify service.",
    paramsSchema: uuidParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/services/${params.uuid}/restart`);
      checkOk(res.status, res.data, "restart_service");
      return res.data;
    },
  };

  // ---- Servers / Projects / Teams ------------------------------------------
  const listServers: ActionDef<Record<string, never>> = {
    id: "list_servers",
    summary: "List all servers connected to this Coolify instance.",
    paramsSchema: z.object({}),
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/servers");
      checkOk(res.status, res.data, "list_servers");
      return res.data;
    },
  };

  const getServer: ActionDef<z.infer<typeof uuidParams>> = {
    id: "get_server",
    summary: "Get full details of one Coolify server by uuid, including reachability/usability status.",
    paramsSchema: uuidParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/servers/${params.uuid}`);
      checkOk(res.status, res.data, "get_server");
      return res.data;
    },
  };

  const listProjects: ActionDef<Record<string, never>> = {
    id: "list_projects",
    summary: "List all Coolify projects.",
    paramsSchema: z.object({}),
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/projects");
      checkOk(res.status, res.data, "list_projects");
      return res.data;
    },
  };

  const getProject: ActionDef<z.infer<typeof uuidParams>> = {
    id: "get_project",
    summary: "Get full details of one Coolify project by uuid, including its environments/resources.",
    paramsSchema: uuidParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/projects/${params.uuid}`);
      checkOk(res.status, res.data, "get_project");
      return res.data;
    },
  };

  const listTeams: ActionDef<Record<string, never>> = {
    id: "list_teams",
    summary: "List all teams this Coolify API token has access to.",
    paramsSchema: z.object({}),
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/teams");
      checkOk(res.status, res.data, "list_teams");
      return res.data;
    },
  };

  return [
    listApplications,
    getApplication,
    startApplication,
    stopApplication,
    restartApplication,
    deploy,
    getApplicationLogs,
    listApplicationEnvs,
    createApplicationEnv,
    deleteApplicationEnv,
    listDeployments,
    getDeployment,
    listDatabases,
    getDatabase,
    startDatabase,
    stopDatabase,
    restartDatabase,
    listServices,
    getService,
    startService,
    stopService,
    restartService,
    listServers,
    getServer,
    listProjects,
    getProject,
    listTeams,
  ];
}

const coolifyService: ServiceModule = {
  id: "coolify",
  label: "Coolify",
  description:
    "Coolify self-hosted PaaS administration (applications, databases, services, deployments, servers, projects) via the REST API v1 (API Token auth).",
  parseInstanceFields: (fields) => {
    const baseUrl = requireField(fields, "baseUrl", "Coolify");
    const apiToken = requireField(fields, "apiToken", "Coolify");
    const insecureTls = optionalField(fields, "insecureTls", "false");
    return compact({ baseUrl, apiToken, insecureTls });
  },
  exampleFields: ["BASE_URL", "API_TOKEN", "INSECURE_TLS"],
  buildActions,
};

export default coolifyService;
