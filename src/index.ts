import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Registry, McpUserError } from "./core/registry.js";
import { allServiceModules } from "./services/index.js";

// Registered MCP clients spawn this process with an arbitrary cwd (often the client's own
// project directory, not this one) - load .env from next to the built dist/index.js, not from
// process.cwd(), so it's found regardless of where/how the server is launched.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(moduleDir, "..", ".env") });

const registry = new Registry();
registry.loadFromEnv(allServiceModules, process.env);

const server = new McpServer({ name: "master-mcp", version: "0.1.0" });

function textResult(value: unknown, isError = false) {
  return {
    isError,
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown) {
  if (err instanceof McpUserError) return textResult(`Error: ${err.message}`, true);
  const message = err instanceof Error ? err.message : String(err);
  return textResult(`Unexpected error: ${message}`, true);
}

server.registerTool(
  "list_services",
  {
    description:
      "List all admin services this MCP can reach (Uptime Kuma, NPMPlus/Nginx Proxy Manager, Porkbun, " +
      "Cloudflare, Docker, Proxmox), which are configured, and which named instances exist for each " +
      "(e.g. multiple Docker hosts or Proxmox nodes with separate credentials). Call this first if you're " +
      "unsure what's available.",
    inputSchema: {},
  },
  async () => {
    try {
      return textResult(registry.listServices());
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "list_actions",
  {
    description:
      "Search/list available actions across configured services. Returns each action's id, owning service, " +
      "a one-line summary, whether it's read-only or destructive, and its JSON input schema. Use `query` to " +
      "search by keyword (e.g. 'restart container', 'dns record', 'proxy host'); omit both filters to list " +
      "everything. Only configured services' actions are returned.",
    inputSchema: {
      service: z.string().optional().describe("Restrict to one service id, e.g. 'docker' or 'proxmox'."),
      query: z.string().optional().describe("Free-text keyword search over action id/summary/service."),
    },
  },
  async ({ service, query }) => {
    try {
      return textResult(registry.listActions({ service, query }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "execute_action",
  {
    description:
      "Execute one action against one instance of a service. Look up the action id and its params schema via " +
      "list_actions first. `instance` selects which configured target to use (e.g. which Proxmox node or " +
      "Docker host) - omit it only if the service has exactly one instance configured. Destructive actions " +
      "(as flagged by list_actions) change or delete remote state - double check params before calling.",
    inputSchema: {
      service: z.string().describe("Service id, e.g. 'docker', 'proxmox', 'cloudflare'."),
      action: z.string().describe("Action id as returned by list_actions."),
      instance: z.string().optional().describe("Instance id, e.g. 'home'. Required if the service has more than one instance."),
      params: z.record(z.unknown()).optional().describe("Action-specific params object, validated against its schema."),
    },
  },
  async ({ service, action, instance, params }) => {
    try {
      const actionDef = registry.findAction(service, action);
      const instanceConfig = registry.resolveInstance(service, instance);
      const parsed = actionDef.paramsSchema.safeParse(params ?? {});
      if (!parsed.success) {
        return textResult(`Invalid params for ${service}.${action}: ${parsed.error.message}`, true);
      }
      const result = await actionDef.handler(parsed.data, instanceConfig);
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
