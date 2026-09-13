import { z } from "zod";
import type { ActionDef, AnyActionDef, InstanceConfig, ServiceModule } from "../core/types.js";
import { assertOk, makeHttpClient, optionalField, requireField } from "../core/http.js";

const API_PREFIX = "/api/v3";

/** Builds a fresh axios client authenticated for this instance, scoped to the API v3 base path. */
function clientFor(instance: InstanceConfig) {
  const baseUrl = requireField(instance.fields, "baseUrl", "Authentik");
  const apiToken = requireField(instance.fields, "apiToken", "Authentik");
  const insecureTls = instance.fields.insecureTls === "true";
  return makeHttpClient(`${baseUrl.replace(/\/+$/, "")}${API_PREFIX}`, {
    insecureTls,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });
}

/** Extracts a `.detail` string from an Authentik error body, if present. */
function extractDetail(data: unknown): string | undefined {
  if (data && typeof data === "object" && "detail" in data) {
    const detail = (data as Record<string, unknown>).detail;
    if (typeof detail === "string") return detail;
  }
  return undefined;
}

/** Asserts HTTP status is 2xx, enriching the error with the API's `.detail` field when present. */
function checkOk(status: number, data: unknown, context: string): void {
  if (status < 200 || status >= 300) {
    const detail = extractDetail(data);
    if (detail) {
      throw new Error(`${context} failed with HTTP ${status}: ${detail}`);
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

const listUsersParams = z.object({
  search: z.string().optional(),
  isActive: z.boolean().optional(),
});

const getUserParams = z.object({
  userId: z.number().int(),
});

const createUserParams = z.object({
  username: z.string().min(1),
  name: z.string().min(1),
  email: z.string().min(1),
  isActive: z.boolean().optional(),
  groups: z.array(z.number().int()).optional(),
});

const updateUserParams = z.object({
  userId: z.number().int(),
  name: z.string().optional(),
  email: z.string().optional(),
  isActive: z.boolean().optional(),
});

const deleteUserParams = z.object({
  userId: z.number().int(),
});

const setUserPasswordParams = z.object({
  userId: z.number().int(),
  password: z.string().min(1),
});

const listGroupsParams = z.object({
  search: z.string().optional(),
});

const createGroupParams = z.object({
  name: z.string().min(1),
  isSuperuser: z.boolean().optional(),
});

const addUserToGroupParams = z.object({
  groupId: z.string().min(1),
  userId: z.number().int(),
});

const removeUserFromGroupParams = z.object({
  groupId: z.string().min(1),
  userId: z.number().int(),
});

const listApplicationsParams = z.object({
  search: z.string().optional(),
});

const listProvidersParams = z.object({});

const listOutpostsParams = z.object({});

const listFlowsParams = z.object({
  search: z.string().optional(),
});

const listEventsParams = z.object({
  pageSize: z.number().int().positive().optional(),
  ordering: z.string().optional(),
});

const createInvitationParams = z.object({
  name: z.string().min(1),
  expires: z.string().optional(),
  fixedData: z.record(z.unknown()).optional(),
});

function buildActions(): AnyActionDef[] {
  const listUsers: ActionDef<z.infer<typeof listUsersParams>> = {
    id: "list_users",
    summary: "List Authentik users, optionally filtered by search text or active status.",
    paramsSchema: listUsersParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/core/users/", {
        params: compact({
          search: params.search,
          is_active: params.isActive,
        }),
      });
      checkOk(res.status, res.data, "list_users");
      return res.data;
    },
  };

  const getUser: ActionDef<z.infer<typeof getUserParams>> = {
    id: "get_user",
    summary: "Get details of a single Authentik user by id.",
    paramsSchema: getUserParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/core/users/${params.userId}/`);
      checkOk(res.status, res.data, "get_user");
      return res.data;
    },
  };

  const createUser: ActionDef<z.infer<typeof createUserParams>> = {
    id: "create_user",
    summary: "Create a new Authentik user with username, name, email and optional group memberships.",
    paramsSchema: createUserParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post("/core/users/", {
        username: params.username,
        name: params.name,
        email: params.email,
        is_active: params.isActive ?? true,
        groups: params.groups ?? [],
      });
      checkOk(res.status, res.data, "create_user");
      return res.data;
    },
  };

  const updateUser: ActionDef<z.infer<typeof updateUserParams>> = {
    id: "update_user",
    summary: "Update name, email, or active status of an existing Authentik user.",
    paramsSchema: updateUserParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.patch(
        `/core/users/${params.userId}/`,
        compact({
          name: params.name,
          email: params.email,
          is_active: params.isActive,
        })
      );
      checkOk(res.status, res.data, "update_user");
      return res.data;
    },
  };

  const deleteUser: ActionDef<z.infer<typeof deleteUserParams>> = {
    id: "delete_user",
    summary: "Delete an Authentik user by id. Irreversible.",
    paramsSchema: deleteUserParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.delete(`/core/users/${params.userId}/`);
      checkOk(res.status, res.data, "delete_user");
      return res.data;
    },
  };

  const setUserPassword: ActionDef<z.infer<typeof setUserPasswordParams>> = {
    id: "set_user_password",
    summary: "Set (reset) an Authentik user's password.",
    paramsSchema: setUserPasswordParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/core/users/${params.userId}/set_password/`, {
        password: params.password,
      });
      checkOk(res.status, res.data, "set_user_password");
      return res.data;
    },
  };

  const listGroups: ActionDef<z.infer<typeof listGroupsParams>> = {
    id: "list_groups",
    summary: "List Authentik groups, optionally filtered by search text.",
    paramsSchema: listGroupsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/core/groups/", {
        params: compact({ search: params.search }),
      });
      checkOk(res.status, res.data, "list_groups");
      return res.data;
    },
  };

  const createGroup: ActionDef<z.infer<typeof createGroupParams>> = {
    id: "create_group",
    summary: "Create a new Authentik group, optionally granting superuser privileges.",
    paramsSchema: createGroupParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post("/core/groups/", {
        name: params.name,
        is_superuser: params.isSuperuser ?? false,
      });
      checkOk(res.status, res.data, "create_group");
      return res.data;
    },
  };

  const addUserToGroup: ActionDef<z.infer<typeof addUserToGroupParams>> = {
    id: "add_user_to_group",
    summary: "Add a user to an Authentik group by group id.",
    paramsSchema: addUserToGroupParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/core/groups/${encodeURIComponent(params.groupId)}/add_user/`, {
        pk: params.userId,
      });
      checkOk(res.status, res.data, "add_user_to_group");
      return res.data;
    },
  };

  const removeUserFromGroup: ActionDef<z.infer<typeof removeUserFromGroupParams>> = {
    id: "remove_user_from_group",
    summary: "Remove a user from an Authentik group by group id.",
    paramsSchema: removeUserFromGroupParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(`/core/groups/${encodeURIComponent(params.groupId)}/remove_user/`, {
        pk: params.userId,
      });
      checkOk(res.status, res.data, "remove_user_from_group");
      return res.data;
    },
  };

  const listApplications: ActionDef<z.infer<typeof listApplicationsParams>> = {
    id: "list_applications",
    summary: "List Authentik applications, optionally filtered by search text.",
    paramsSchema: listApplicationsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/core/applications/", {
        params: compact({ search: params.search }),
      });
      checkOk(res.status, res.data, "list_applications");
      return res.data;
    },
  };

  const listProviders: ActionDef<z.infer<typeof listProvidersParams>> = {
    id: "list_providers",
    summary: "List all Authentik providers (all types combined: OAuth2, SAML, proxy, LDAP, etc).",
    paramsSchema: listProvidersParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/providers/all/");
      checkOk(res.status, res.data, "list_providers");
      return res.data;
    },
  };

  const listOutposts: ActionDef<z.infer<typeof listOutpostsParams>> = {
    id: "list_outposts",
    summary: "List Authentik outpost instances (proxy/LDAP/RADIUS deployments) and their health.",
    paramsSchema: listOutpostsParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/outposts/instances/");
      checkOk(res.status, res.data, "list_outposts");
      return res.data;
    },
  };

  const listFlows: ActionDef<z.infer<typeof listFlowsParams>> = {
    id: "list_flows",
    summary: "List Authentik flows (login, enrollment, recovery, etc), optionally filtered by search text.",
    paramsSchema: listFlowsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/flows/instances/", {
        params: compact({ search: params.search }),
      });
      checkOk(res.status, res.data, "list_flows");
      return res.data;
    },
  };

  const listEvents: ActionDef<z.infer<typeof listEventsParams>> = {
    id: "list_events",
    summary: "List Authentik audit log events, most recent first by default.",
    paramsSchema: listEventsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/events/events/", {
        params: {
          page_size: params.pageSize ?? 20,
          ordering: params.ordering ?? "-created",
        },
      });
      checkOk(res.status, res.data, "list_events");
      return res.data;
    },
  };

  const createInvitation: ActionDef<z.infer<typeof createInvitationParams>> = {
    id: "create_invitation",
    summary: "Create an Authentik enrollment invitation, optionally with fixed pre-filled data and an expiry.",
    paramsSchema: createInvitationParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(
        "/stages/invitation/invitations/",
        compact({
          name: params.name,
          expires: params.expires,
          fixed_data: params.fixedData ?? {},
        })
      );
      checkOk(res.status, res.data, "create_invitation");
      return res.data;
    },
  };

  return [
    listUsers,
    getUser,
    createUser,
    updateUser,
    deleteUser,
    setUserPassword,
    listGroups,
    createGroup,
    addUserToGroup,
    removeUserFromGroup,
    listApplications,
    listProviders,
    listOutposts,
    listFlows,
    listEvents,
    createInvitation,
  ];
}

const authentikService: ServiceModule = {
  id: "authentik",
  label: "Authentik",
  description: "Authentik self-hosted SSO/Identity Provider administration via the REST API v3 (API Token auth).",
  parseInstanceFields: (fields) => {
    const baseUrl = requireField(fields, "baseUrl", "Authentik");
    const apiToken = requireField(fields, "apiToken", "Authentik");
    const insecureTls = optionalField(fields, "insecureTls", "false");
    return compact({ baseUrl, apiToken, insecureTls });
  },
  exampleFields: ["BASE_URL", "API_TOKEN", "INSECURE_TLS"],
  buildActions,
};

export default authentikService;
