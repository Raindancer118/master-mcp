import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import https from "node:https";

export function requireField(fields: Record<string, string>, name: string, serviceLabel: string): string {
  const value = fields[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required field "${name}" for ${serviceLabel} instance (expected env var suffix ${toEnvSuffix(name)})`);
  }
  return value;
}

export function optionalField(fields: Record<string, string>, name: string, fallback?: string): string | undefined {
  const value = fields[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value;
}

function toEnvSuffix(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
}

/** Builds an axios client with a base URL, sane timeout, and optional TLS-verify skip (self-signed certs on LAN devices like Proxmox/NPM). */
export function makeHttpClient(baseUrl: string, opts: { insecureTls?: boolean; headers?: Record<string, string> } = {}): AxiosInstance {
  const config: AxiosRequestConfig = {
    baseURL: baseUrl.replace(/\/+$/, ""),
    timeout: 15_000,
    headers: opts.headers,
    validateStatus: () => true, // handle non-2xx ourselves for clearer error messages
  };
  if (opts.insecureTls) {
    config.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }
  return axios.create(config);
}

export function assertOk(status: number, data: unknown, context: string): void {
  if (status < 200 || status >= 300) {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${context} failed with HTTP ${status}: ${body?.slice(0, 500)}`);
  }
}
