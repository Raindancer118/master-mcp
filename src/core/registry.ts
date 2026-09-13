import { zodToJsonSchema } from "zod-to-json-schema";
import { discoverRawInstances } from "./instances.js";
import type { AnyActionDef, InstanceConfig, ServiceModule } from "./types.js";

export class McpUserError extends Error {}

interface RegisteredService {
  module: ServiceModule;
  actions: Map<string, AnyActionDef>;
  instances: Map<string, InstanceConfig>;
  instanceErrors: { id: string; error: string }[];
}

export interface ServiceSummary {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  instances: string[];
  instanceErrors: { id: string; error: string }[];
  exampleFields: string[];
}

export interface ActionSummary {
  service: string;
  action: string;
  summary: string;
  readOnly: boolean;
  destructive: boolean;
  paramsSchema: Record<string, unknown>;
}

export class Registry {
  private services = new Map<string, RegisteredService>();

  loadFromEnv(modules: ServiceModule[], env: NodeJS.ProcessEnv): void {
    for (const module of modules) {
      const raw = discoverRawInstances(module.id, env);
      const instances = new Map<string, InstanceConfig>();
      const instanceErrors: { id: string; error: string }[] = [];

      for (const r of raw) {
        try {
          const fields = module.parseInstanceFields(r.fields);
          instances.set(r.id, { id: r.id, fields });
        } catch (err) {
          instanceErrors.push({ id: r.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const actions = new Map<string, AnyActionDef>();
      if (instances.size > 0) {
        for (const action of module.buildActions()) {
          if (actions.has(action.id)) {
            throw new Error(`Duplicate action id "${action.id}" in service "${module.id}"`);
          }
          actions.set(action.id, action);
        }
      }

      this.services.set(module.id, { module, actions, instances, instanceErrors });
    }
  }

  listServices(): ServiceSummary[] {
    return [...this.services.values()].map((s) => ({
      id: s.module.id,
      label: s.module.label,
      description: s.module.description,
      configured: s.instances.size > 0,
      instances: [...s.instances.keys()],
      instanceErrors: s.instanceErrors,
      exampleFields: s.module.exampleFields,
    }));
  }

  listActions(opts: { service?: string; query?: string } = {}): ActionSummary[] {
    const q = opts.query?.trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const results: { summary: ActionSummary; score: number }[] = [];

    for (const s of this.services.values()) {
      if (opts.service && s.module.id !== opts.service) continue;
      if (s.instances.size === 0) continue; // unconfigured service: hide its actions from the catalog
      for (const action of s.actions.values()) {
        const haystack = `${s.module.id} ${s.module.label} ${action.id} ${action.summary}`.toLowerCase();
        let score = 0;
        if (terms.length === 0) {
          score = 1;
        } else {
          for (const t of terms) if (haystack.includes(t)) score += 1;
          if (score === 0) continue;
        }
        results.push({
          score,
          summary: {
            service: s.module.id,
            action: action.id,
            summary: action.summary,
            readOnly: action.readOnly,
            destructive: action.destructive,
            paramsSchema: zodToJsonSchema(action.paramsSchema, { target: "jsonSchema7" }) as Record<
              string,
              unknown
            >,
          },
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.map((r) => r.summary);
  }

  private getService(serviceId: string): RegisteredService {
    const s = this.services.get(serviceId);
    if (!s) {
      const known = [...this.services.keys()].join(", ");
      throw new McpUserError(`Unknown service "${serviceId}". Known services: ${known}`);
    }
    return s;
  }

  findAction(serviceId: string, actionId: string): AnyActionDef {
    const s = this.getService(serviceId);
    const action = s.actions.get(actionId);
    if (!action) {
      if (s.instances.size === 0) {
        throw new McpUserError(
          `Service "${serviceId}" is not configured (no instances found in env). ` +
            `Set ${serviceId.toUpperCase()}_INSTANCES plus per-instance fields, or the single-instance ` +
            `shorthand ${serviceId.toUpperCase()}_${s.module.exampleFields[0] ?? "..."}. See .env.example.`
        );
      }
      const known = [...s.actions.keys()].join(", ");
      throw new McpUserError(`Unknown action "${actionId}" for service "${serviceId}". Known actions: ${known}`);
    }
    return action;
  }

  resolveInstance(serviceId: string, instanceId?: string): InstanceConfig {
    const s = this.getService(serviceId);
    if (s.instances.size === 0) {
      const hint = s.instanceErrors.length > 0
        ? ` Configured instance(s) failed validation: ${s.instanceErrors.map((e) => `${e.id}: ${e.error}`).join("; ")}`
        : "";
      throw new McpUserError(
        `Service "${serviceId}" is not configured (no instances found in env).${hint} ` +
          `See .env.example for ${serviceId.toUpperCase()}_* variables.`
      );
    }
    if (instanceId) {
      const inst = s.instances.get(instanceId);
      if (!inst) {
        const known = [...s.instances.keys()].join(", ");
        throw new McpUserError(`Unknown instance "${instanceId}" for service "${serviceId}". Known instances: ${known}`);
      }
      return inst;
    }
    if (s.instances.size === 1) {
      return [...s.instances.values()][0]!;
    }
    const known = [...s.instances.keys()].join(", ");
    throw new McpUserError(
      `Service "${serviceId}" has multiple instances configured (${known}). Pass "instance" explicitly.`
    );
  }
}
