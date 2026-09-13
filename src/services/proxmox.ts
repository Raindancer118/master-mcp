import { z } from "zod";
import type { ActionDef, AnyActionDef, InstanceConfig, ServiceModule } from "../core/types.js";
import { assertOk, makeHttpClient, optionalField, requireField } from "../core/http.js";

type GuestType = "qemu" | "lxc";

/** Builds a fresh axios client authenticated for this instance via a static PVEAPIToken header. */
function clientFor(instance: InstanceConfig) {
  const baseUrl = requireField(instance.fields, "baseUrl", "Proxmox").replace(/\/+$/, "");
  const tokenId = requireField(instance.fields, "tokenId", "Proxmox");
  const tokenSecret = requireField(instance.fields, "tokenSecret", "Proxmox");
  const insecureTls = instance.fields.insecureTls === "true";
  return makeHttpClient(`${baseUrl}/api2/json`, {
    insecureTls,
    headers: {
      Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
    },
  });
}

/** Asserts HTTP status is 2xx, then unwraps Proxmox's `{ data: ... }` envelope. */
function unwrap<T>(status: number, body: { data: T }, context: string): T {
  assertOk(status, body, context);
  return body.data;
}

interface ProxmoxNode {
  node: string;
  status?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
  [key: string]: unknown;
}

const listNodesParams = z.object({});

const listGuestsParams = z.object({
  node: z.string().min(1).optional(),
  type: z.enum(["qemu", "lxc"]).optional(),
});

const guestRefParams = z.object({
  node: z.string().min(1),
  vmid: z.number().int().positive(),
  type: z.enum(["qemu", "lxc"]),
});

const listStorageParams = z.object({
  node: z.string().min(1).optional(),
});

const clusterStatusParams = z.object({});

const updateGuestConfigParams = z.object({
  node: z.string().min(1),
  vmid: z.number().int().positive(),
  type: z.enum(["qemu", "lxc"]),
  cores: z.number().int().positive().optional(),
  memory: z.number().int().positive().optional(),
  description: z.string().optional(),
});

const snapshotRefParams = z.object({
  node: z.string().min(1),
  vmid: z.number().int().positive(),
  type: z.enum(["qemu", "lxc"]),
  snapname: z.string().min(1),
});

const createSnapshotParams = z.object({
  node: z.string().min(1),
  vmid: z.number().int().positive(),
  type: z.enum(["qemu", "lxc"]),
  snapname: z.string().min(1),
  description: z.string().optional(),
});

const listBackupsParams = z.object({
  node: z.string().min(1),
  storage: z.string().min(1).optional(),
});

const nodeRefParams = z.object({
  node: z.string().min(1),
});

const listUsersParams = z.object({});

const getTaskStatusParams = z.object({
  node: z.string().min(1),
  upid: z.string().min(1),
});

/** Fetches guests of one type on one node, tagging each result with `node` and `type`. */
async function fetchGuestsOnNode(
  client: ReturnType<typeof clientFor>,
  node: string,
  type: GuestType
): Promise<Array<Record<string, unknown>>> {
  const res = await client.get(`/nodes/${encodeURIComponent(node)}/${type}`);
  const guests = unwrap<Array<Record<string, unknown>>>(res.status, res.data, `list_guests(${node}/${type})`);
  return guests.map((g) => ({ ...g, node, type }));
}

function buildActions(): AnyActionDef[] {
  const listNodes: ActionDef<z.infer<typeof listNodesParams>> = {
    id: "list_nodes",
    summary: "List Proxmox cluster nodes with status, CPU, memory and uptime.",
    paramsSchema: listNodesParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/nodes");
      const nodes = unwrap<ProxmoxNode[]>(res.status, res.data, "list_nodes");
      return nodes.map((n) => ({
        node: n.node,
        status: n.status,
        cpu: n.cpu,
        mem: n.mem,
        maxmem: n.maxmem,
        uptime: n.uptime,
      }));
    },
  };

  const listGuests: ActionDef<z.infer<typeof listGuestsParams>> = {
    id: "list_guests",
    summary: "List VMs (qemu) and/or LXC containers, on one node or aggregated across the whole cluster.",
    paramsSchema: listGuestsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const types: GuestType[] = params.type ? [params.type] : ["qemu", "lxc"];

      let nodes: string[];
      if (params.node) {
        nodes = [params.node];
      } else {
        const res = await client.get("/nodes");
        const nodeList = unwrap<ProxmoxNode[]>(res.status, res.data, "list_guests(nodes)");
        nodes = nodeList.map((n) => n.node);
      }

      const results: Array<Record<string, unknown>> = [];
      for (const node of nodes) {
        for (const type of types) {
          const guests = await fetchGuestsOnNode(client, node, type);
          results.push(...guests);
        }
      }
      return results;
    },
  };

  const getGuestStatus: ActionDef<z.infer<typeof guestRefParams>> = {
    id: "get_guest_status",
    summary: "Get current status (running/stopped, cpu, mem, uptime) of one VM or LXC container.",
    paramsSchema: guestRefParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/status/current`
      );
      return unwrap(res.status, res.data, "get_guest_status");
    },
  };

  const startGuest: ActionDef<z.infer<typeof guestRefParams>> = {
    id: "start_guest",
    summary: "Start a stopped VM or LXC container.",
    paramsSchema: guestRefParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/status/start`
      );
      const upid = unwrap(res.status, res.data, "start_guest");
      return { upid };
    },
  };

  const stopGuest: ActionDef<z.infer<typeof guestRefParams>> = {
    id: "stop_guest",
    summary: "Hard-stop a running VM or LXC container (like pulling the power). Irreversible for unsaved state.",
    paramsSchema: guestRefParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/status/stop`
      );
      const upid = unwrap(res.status, res.data, "stop_guest");
      return { upid };
    },
  };

  const shutdownGuest: ActionDef<z.infer<typeof guestRefParams>> = {
    id: "shutdown_guest",
    summary: "Gracefully shut down a running VM or LXC container via ACPI/agent signal.",
    paramsSchema: guestRefParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/status/shutdown`
      );
      const upid = unwrap(res.status, res.data, "shutdown_guest");
      return { upid };
    },
  };

  const rebootGuest: ActionDef<z.infer<typeof guestRefParams>> = {
    id: "reboot_guest",
    summary: "Gracefully reboot a running VM or LXC container.",
    paramsSchema: guestRefParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/status/reboot`
      );
      const upid = unwrap(res.status, res.data, "reboot_guest");
      return { upid };
    },
  };

  const listStorage: ActionDef<z.infer<typeof listStorageParams>> = {
    id: "list_storage",
    summary: "List storage pools, either on one node or cluster-wide storage configuration.",
    paramsSchema: listStorageParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const path = params.node ? `/nodes/${encodeURIComponent(params.node)}/storage` : "/storage";
      const res = await client.get(path);
      return unwrap(res.status, res.data, "list_storage");
    },
  };

  const clusterStatus: ActionDef<z.infer<typeof clusterStatusParams>> = {
    id: "cluster_status",
    summary: "Get Proxmox cluster status: member nodes, quorum state, and cluster info.",
    paramsSchema: clusterStatusParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/cluster/status");
      return unwrap(res.status, res.data, "cluster_status");
    },
  };

  const getGuestConfig: ActionDef<z.infer<typeof guestRefParams>> = {
    id: "get_guest_config",
    summary: "Get the configuration (cores, memory, disks, network, etc.) of one VM or LXC container.",
    paramsSchema: guestRefParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/config`
      );
      return unwrap(res.status, res.data, "get_guest_config");
    },
  };

  const updateGuestConfig: ActionDef<z.infer<typeof updateGuestConfigParams>> = {
    id: "update_guest_config",
    summary: "Update the configuration (cores, memory, description) of one VM or LXC container.",
    paramsSchema: updateGuestConfigParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const body: Record<string, unknown> = {};
      if (params.cores !== undefined) body.cores = params.cores;
      if (params.memory !== undefined) body.memory = params.memory;
      if (params.description !== undefined) body.description = params.description;
      const res = await client.put(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/config`,
        body
      );
      return unwrap(res.status, res.data, "update_guest_config");
    },
  };

  const listSnapshots: ActionDef<z.infer<typeof guestRefParams>> = {
    id: "list_snapshots",
    summary: "List snapshots of one VM or LXC container.",
    paramsSchema: guestRefParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/snapshot`
      );
      return unwrap(res.status, res.data, "list_snapshots");
    },
  };

  const createSnapshot: ActionDef<z.infer<typeof createSnapshotParams>> = {
    id: "create_snapshot",
    summary: "Create a new snapshot of one VM or LXC container.",
    paramsSchema: createSnapshotParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const body: Record<string, unknown> = { snapname: params.snapname };
      if (params.description !== undefined) body.description = params.description;
      const res = await client.post(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/snapshot`,
        body
      );
      const upid = unwrap(res.status, res.data, "create_snapshot");
      return { upid };
    },
  };

  const deleteSnapshot: ActionDef<z.infer<typeof snapshotRefParams>> = {
    id: "delete_snapshot",
    summary: "Delete a snapshot of one VM or LXC container. Irreversible.",
    paramsSchema: snapshotRefParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.delete(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/snapshot/${encodeURIComponent(params.snapname)}`
      );
      const upid = unwrap(res.status, res.data, "delete_snapshot");
      return { upid };
    },
  };

  const rollbackSnapshot: ActionDef<z.infer<typeof snapshotRefParams>> = {
    id: "rollback_snapshot",
    summary: "Roll back one VM or LXC container to a snapshot, discarding current state. Irreversible.",
    paramsSchema: snapshotRefParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.post(
        `/nodes/${encodeURIComponent(params.node)}/${params.type}/${params.vmid}/snapshot/${encodeURIComponent(params.snapname)}/rollback`
      );
      const upid = unwrap(res.status, res.data, "rollback_snapshot");
      return { upid };
    },
  };

  const listBackups: ActionDef<z.infer<typeof listBackupsParams>> = {
    id: "list_backups",
    summary: "List backup archives on one node, either on a given storage or aggregated across all storages that support backups.",
    paramsSchema: listBackupsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const node = params.node;

      if (params.storage) {
        const res = await client.get(
          `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(params.storage)}/content`,
          { params: { content: "backup" } }
        );
        return unwrap(res.status, res.data, "list_backups");
      }

      const storageRes = await client.get(`/nodes/${encodeURIComponent(node)}/storage`);
      const storages = unwrap<Array<Record<string, unknown>>>(
        storageRes.status,
        storageRes.data,
        "list_backups(storage)"
      );

      const results: Array<Record<string, unknown>> = [];
      for (const storage of storages) {
        const content = typeof storage.content === "string" ? storage.content : "";
        if (!content.split(",").includes("backup")) continue;
        const storageId = String(storage.storage);
        const res = await client.get(
          `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storageId)}/content`,
          { params: { content: "backup" } }
        );
        const items = unwrap<Array<Record<string, unknown>>>(
          res.status,
          res.data,
          `list_backups(${storageId})`
        );
        results.push(...items.map((i) => ({ ...i, storage: storageId })));
      }
      return results;
    },
  };

  const getNodeStatus: ActionDef<z.infer<typeof nodeRefParams>> = {
    id: "get_node_status",
    summary: "Get detailed node status: uptime, load average, memory, and CPU info.",
    paramsSchema: nodeRefParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(`/nodes/${encodeURIComponent(params.node)}/status`);
      return unwrap(res.status, res.data, "get_node_status");
    },
  };

  const listUsers: ActionDef<z.infer<typeof listUsersParams>> = {
    id: "list_users",
    summary: "List Proxmox access-control users.",
    paramsSchema: listUsersParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const client = clientFor(instance);
      const res = await client.get("/access/users");
      return unwrap(res.status, res.data, "list_users");
    },
  };

  const getTaskStatus: ActionDef<z.infer<typeof getTaskStatusParams>> = {
    id: "get_task_status",
    summary: "Get the status of a background task by UPID (e.g. to poll a start/stop/reboot/snapshot task).",
    paramsSchema: getTaskStatusParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const client = clientFor(instance);
      const res = await client.get(
        `/nodes/${encodeURIComponent(params.node)}/tasks/${encodeURIComponent(params.upid)}/status`
      );
      return unwrap(res.status, res.data, "get_task_status");
    },
  };

  return [
    listNodes,
    listGuests,
    getGuestStatus,
    startGuest,
    stopGuest,
    shutdownGuest,
    rebootGuest,
    listStorage,
    clusterStatus,
    getGuestConfig,
    updateGuestConfig,
    listSnapshots,
    createSnapshot,
    deleteSnapshot,
    rollbackSnapshot,
    listBackups,
    getNodeStatus,
    listUsers,
    getTaskStatus,
  ];
}

const proxmoxService: ServiceModule = {
  id: "proxmox",
  label: "Proxmox VE",
  description: "Proxmox VE node/VM/LXC/storage/cluster administration via the REST API (API Token auth).",
  parseInstanceFields: (fields) => {
    const baseUrl = requireField(fields, "baseUrl", "Proxmox").replace(/\/+$/, "");
    const tokenId = requireField(fields, "tokenId", "Proxmox");
    const tokenSecret = requireField(fields, "tokenSecret", "Proxmox");
    const insecureTls = optionalField(fields, "insecureTls");
    const result: Record<string, string> = { baseUrl, tokenId, tokenSecret };
    if (insecureTls !== undefined) result.insecureTls = insecureTls === "true" ? "true" : "false";
    return result;
  },
  exampleFields: ["BASE_URL", "TOKEN_ID", "TOKEN_SECRET", "INSECURE_TLS"],
  buildActions,
};

export default proxmoxService;
