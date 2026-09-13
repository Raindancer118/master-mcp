import type { ServiceModule } from "../core/types.js";
import cloudflare from "./cloudflare.js";
import porkbun from "./porkbun.js";
import docker from "./docker.js";
import proxmox from "./proxmox.js";
import npm from "./npm.js";
import uptimeKuma from "./uptimeKuma.js";
import authentik from "./authentik.js";
import coolify from "./coolify.js";

export const allServiceModules: ServiceModule[] = [
  cloudflare,
  porkbun,
  docker,
  proxmox,
  npm,
  uptimeKuma,
  authentik,
  coolify,
];
