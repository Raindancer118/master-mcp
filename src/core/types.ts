import type { z } from "zod";

/** Resolved config for one instance of a service (e.g. one Proxmox node, one Docker host). */
export interface InstanceConfig {
  /** Instance id as configured, e.g. "home", "office", "default". */
  id: string;
  /** Raw fields gathered from env, camelCased (BASE_URL -> baseUrl). Shape is service-specific. */
  fields: Record<string, string>;
}

export interface ActionDef<P = unknown, R = unknown> {
  /** Unique within its service, e.g. "restart_container". */
  id: string;
  /** One-line, keyword-rich description used for search + display. */
  summary: string;
  /** Zod schema describing the params object (excluding service/action/instance). */
  paramsSchema: z.ZodType<P>;
  /** True if this action only reads state (safe, no side effects). */
  readOnly: boolean;
  /** True if this action changes/deletes state in a way that's hard to undo. */
  destructive: boolean;
  handler: (params: P, instance: InstanceConfig) => Promise<R>;
}

export type AnyActionDef = ActionDef<any, any>;

export interface ServiceModule {
  /** Service namespace, e.g. "cloudflare". Used as the env var prefix (uppercased). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Short description of what this service integration covers. */
  description: string;
  /**
   * Validates + normalizes one instance's raw fields (from env). Throw a descriptive
   * error if required fields are missing/invalid - surfaced at startup per instance.
   */
  parseInstanceFields: (fields: Record<string, string>) => Record<string, string>;
  /** Example env var block shown in docs/errors, e.g. ["BASE_URL", "API_TOKEN"]. */
  exampleFields: string[];
  buildActions: () => AnyActionDef[];
}
