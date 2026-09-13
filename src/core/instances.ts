/**
 * Multi-instance config discovery from environment variables.
 *
 * Two supported shapes per service (prefix = service id uppercased, e.g. "PROXMOX"):
 *
 * Single instance (shorthand), instance id becomes "default":
 *   PROXMOX_BASE_URL=https://10.0.0.5:8006
 *   PROXMOX_TOKEN_ID=root@pam!mcp
 *   PROXMOX_TOKEN_SECRET=xxxx
 *
 * Multiple named instances:
 *   PROXMOX_INSTANCES=home,work
 *   PROXMOX_HOME_BASE_URL=https://10.0.0.5:8006
 *   PROXMOX_HOME_TOKEN_ID=root@pam!mcp
 *   PROXMOX_HOME_TOKEN_SECRET=xxxx
 *   PROXMOX_WORK_BASE_URL=https://192.168.1.9:8006
 *   PROXMOX_WORK_TOKEN_ID=...
 *   PROXMOX_WORK_TOKEN_SECRET=...
 */

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function envKeyToCamel(key: string): string {
  const parts = key.toLowerCase().split("_").filter(Boolean);
  return parts
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

export interface RawInstance {
  id: string;
  fields: Record<string, string>;
}

export function discoverRawInstances(servicePrefix: string, env: NodeJS.ProcessEnv): RawInstance[] {
  const prefix = `${servicePrefix.toUpperCase()}_`;
  const instancesVar = env[`${servicePrefix.toUpperCase()}_INSTANCES`];

  if (instancesVar && instancesVar.trim() !== "") {
    const ids = instancesVar
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    return ids.map((id) => {
      if (!INSTANCE_ID_RE.test(id)) {
        throw new Error(
          `Invalid instance id "${id}" for ${servicePrefix}_INSTANCES: use lowercase letters, digits, "-" or "_" only.`
        );
      }
      const idPrefix = `${prefix}${id.toUpperCase()}_`;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (!key.startsWith(idPrefix)) continue;
        fields[envKeyToCamel(key.slice(idPrefix.length))] = value;
      }
      return { id, fields };
    });
  }

  // Single-instance shorthand: any other SERVICE_* var present (excluding _INSTANCES).
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!key.startsWith(prefix)) continue;
    if (key === `${servicePrefix.toUpperCase()}_INSTANCES`) continue;
    fields[envKeyToCamel(key.slice(prefix.length))] = value;
  }
  if (Object.keys(fields).length === 0) return [];
  return [{ id: "default", fields }];
}
