import Docker from "dockerode";
import { z } from "zod";
import type { ActionDef, AnyActionDef, InstanceConfig, ServiceModule } from "../core/types.js";
import { optionalField } from "../core/http.js";

/**
 * Builds a fresh dockerode client for this instance.
 *
 * Two mutually exclusive connection modes (enforced in parseInstanceFields):
 *  - Local socket: fields.socketPath (env SOCKET_PATH), e.g. /var/run/docker.sock
 *  - Remote TCP: fields.host (env HOST) + optional fields.port (env PORT, no default -
 *    caller must be explicit: 2375 plain / 2376 TLS), optional fields.tls ("true"/"false",
 *    env TLS) plus optional mutual-TLS material fields.tlsCa/tlsCert/tlsKey (env TLS_CA/
 *    TLS_CERT/TLS_KEY). These are passed straight through to dockerode's ca/cert/key options,
 *    which accept either raw PEM content or a Buffer - so set the env var to the PEM content
 *    directly (e.g. via a multi-line env value or your secret manager), not a file path.
 */
function clientFor(instance: InstanceConfig): Docker {
  const f = instance.fields;
  if (f.socketPath) {
    return new Docker({ socketPath: f.socketPath });
  }
  const options: Docker.DockerOptions = {
    host: f.host,
    port: Number(f.port ?? 2375),
  };
  if (f.tls === "true") {
    options.protocol = "https";
    if (f.tlsCa) options.ca = f.tlsCa;
    if (f.tlsCert) options.cert = f.tlsCert;
    if (f.tlsKey) options.key = f.tlsKey;
  }
  return new Docker(options);
}

/** Trims a dockerode ContainerInfo down to the fields worth showing an LLM. */
function trimContainer(c: Docker.ContainerInfo) {
  return {
    id: c.Id,
    names: c.Names,
    image: c.Image,
    state: c.State,
    status: c.Status,
    ports: c.Ports,
  };
}

/**
 * Docker container logs are frame-multiplexed (8-byte header: 1 byte stream type, 3 reserved
 * bytes, 4-byte big-endian payload length) when the container was created without a TTY, but
 * are raw text when it was created with one. Demux when frames parse cleanly, else fall back
 * to treating the buffer as plain text.
 */
function demuxLogs(buffer: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer.readUInt8(offset);
    if (streamType > 2) break; // not a valid frame header - not multiplexed, bail to fallback
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    parts.push(buffer.subarray(start, end).toString("utf8"));
    offset = end;
  }
  if (offset === buffer.length && parts.length > 0) {
    return parts.join("");
  }
  return buffer.toString("utf8");
}

/** Pulls an image and resolves once the pull completes (or rejects on error), via followProgress. */
async function pullAndAwait(docker: Docker, ref: string): Promise<void> {
  const stream = await docker.pull(ref);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

const listContainersParams = z.object({
  all: z.boolean().optional(),
});

const containerIdParams = z.object({
  containerId: z.string().min(1),
});

const stopContainerParams = z.object({
  containerId: z.string().min(1),
  timeoutSeconds: z.number().int().positive().optional(),
});

const restartContainerParams = z.object({
  containerId: z.string().min(1),
  timeoutSeconds: z.number().int().positive().optional(),
});

const removeContainerParams = z.object({
  containerId: z.string().min(1),
  force: z.boolean().optional(),
  removeVolumes: z.boolean().optional(),
});

const containerLogsParams = z.object({
  containerId: z.string().min(1),
  tail: z.number().int().positive().optional(),
});

const pullImageParams = z.object({
  image: z.string().min(1),
  tag: z.string().min(1).optional(),
});

const emptyParams = z.object({});

function buildActions(): AnyActionDef[] {
  const listContainers: ActionDef<z.infer<typeof listContainersParams>> = {
    id: "list_containers",
    summary: "List Docker containers (running by default all=true includes stopped too).",
    paramsSchema: listContainersParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const docker = clientFor(instance);
      const containers = await docker.listContainers({ all: params.all ?? true });
      return containers.map(trimContainer);
    },
  };

  const inspectContainer: ActionDef<z.infer<typeof containerIdParams>> = {
    id: "inspect_container",
    summary: "Get full inspect details (config, state, mounts, network) for one Docker container.",
    paramsSchema: containerIdParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const docker = clientFor(instance);
      return docker.getContainer(params.containerId).inspect();
    },
  };

  const startContainer: ActionDef<z.infer<typeof containerIdParams>> = {
    id: "start_container",
    summary: "Start a stopped Docker container.",
    paramsSchema: containerIdParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const docker = clientFor(instance);
      await docker.getContainer(params.containerId).start();
      return { success: true, containerId: params.containerId };
    },
  };

  const stopContainer: ActionDef<z.infer<typeof stopContainerParams>> = {
    id: "stop_container",
    summary: "Stop a running Docker container, optionally with a grace timeout in seconds.",
    paramsSchema: stopContainerParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const docker = clientFor(instance);
      const options = params.timeoutSeconds !== undefined ? { t: params.timeoutSeconds } : {};
      await docker.getContainer(params.containerId).stop(options);
      return { success: true, containerId: params.containerId };
    },
  };

  const restartContainer: ActionDef<z.infer<typeof restartContainerParams>> = {
    id: "restart_container",
    summary: "Restart a Docker container, optionally with a grace timeout in seconds.",
    paramsSchema: restartContainerParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const docker = clientFor(instance);
      const options = params.timeoutSeconds !== undefined ? { t: params.timeoutSeconds } : {};
      await docker.getContainer(params.containerId).restart(options);
      return { success: true, containerId: params.containerId };
    },
  };

  const removeContainer: ActionDef<z.infer<typeof removeContainerParams>> = {
    id: "remove_container",
    summary: "Remove a Docker container, optionally forcing (if running) and removing its volumes. Irreversible.",
    paramsSchema: removeContainerParams,
    readOnly: false,
    destructive: true,
    handler: async (params, instance) => {
      const docker = clientFor(instance);
      await docker.getContainer(params.containerId).remove({
        force: params.force,
        v: params.removeVolumes,
      });
      return { success: true, containerId: params.containerId };
    },
  };

  const containerLogs: ActionDef<z.infer<typeof containerLogsParams>> = {
    id: "container_logs",
    summary: "Fetch recent stdout/stderr log output (with timestamps) from a Docker container.",
    paramsSchema: containerLogsParams,
    readOnly: true,
    destructive: false,
    handler: async (params, instance) => {
      const docker = clientFor(instance);
      const buffer = await docker.getContainer(params.containerId).logs({
        stdout: true,
        stderr: true,
        tail: params.tail ?? 200,
        timestamps: true,
        follow: false,
      });
      return demuxLogs(buffer);
    },
  };

  const listImages: ActionDef<z.infer<typeof emptyParams>> = {
    id: "list_images",
    summary: "List Docker images present on the host.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const docker = clientFor(instance);
      return docker.listImages();
    },
  };

  const pullImage: ActionDef<z.infer<typeof pullImageParams>> = {
    id: "pull_image",
    summary: "Pull a Docker image (optionally a specific tag, default 'latest') from its registry.",
    paramsSchema: pullImageParams,
    readOnly: false,
    destructive: false,
    handler: async (params, instance) => {
      const docker = clientFor(instance);
      const tag = params.tag ?? "latest";
      const ref = `${params.image}:${tag}`;
      await pullAndAwait(docker, ref);
      return { success: true, image: ref };
    },
  };

  const listVolumes: ActionDef<z.infer<typeof emptyParams>> = {
    id: "list_volumes",
    summary: "List Docker volumes on the host.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const docker = clientFor(instance);
      return docker.listVolumes();
    },
  };

  const listNetworks: ActionDef<z.infer<typeof emptyParams>> = {
    id: "list_networks",
    summary: "List Docker networks on the host.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const docker = clientFor(instance);
      return docker.listNetworks();
    },
  };

  const dockerInfo: ActionDef<z.infer<typeof emptyParams>> = {
    id: "docker_info",
    summary: "Get a compact summary of the Docker host: container/image counts, version, OS, CPU, memory.",
    paramsSchema: emptyParams,
    readOnly: true,
    destructive: false,
    handler: async (_params, instance) => {
      const docker = clientFor(instance);
      const info = await docker.info();
      return {
        id: info.ID,
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        containersPaused: info.ContainersPaused,
        containersStopped: info.ContainersStopped,
        images: info.Images,
        serverVersion: info.ServerVersion,
        operatingSystem: info.OperatingSystem,
        ncpu: info.NCPU,
        memTotal: info.MemTotal,
        dockerRootDir: info.DockerRootDir,
      };
    },
  };

  return [
    listContainers,
    inspectContainer,
    startContainer,
    stopContainer,
    restartContainer,
    removeContainer,
    containerLogs,
    listImages,
    pullImage,
    listVolumes,
    listNetworks,
    dockerInfo,
  ];
}

const dockerService: ServiceModule = {
  id: "docker",
  label: "Docker",
  description: "Docker Engine administration (containers, images, volumes, networks) via local socket or remote TCP.",
  parseInstanceFields: (fields) => {
    const socketPath = optionalField(fields, "socketPath");
    const host = optionalField(fields, "host");

    if (!socketPath && !host) {
      throw new Error(
        "Docker instance requires either socketPath (env SOCKET_PATH, e.g. /var/run/docker.sock) or host (env HOST) to be set."
      );
    }
    if (socketPath && host) {
      throw new Error(
        "Docker instance has both socketPath and host set - ambiguous, configure exactly one connection mode."
      );
    }

    if (socketPath) {
      return { socketPath };
    }

    const result: Record<string, string> = { host: host! };

    const port = optionalField(fields, "port");
    if (port !== undefined) {
      if (!/^\d+$/.test(port)) {
        throw new Error(`Docker instance port must be numeric, got "${port}".`);
      }
      result.port = port;
    }

    const tls = optionalField(fields, "tls");
    if (tls !== undefined) {
      if (tls !== "true" && tls !== "false") {
        throw new Error(`Docker instance tls must be "true" or "false", got "${tls}".`);
      }
      result.tls = tls;
    }

    const tlsCa = optionalField(fields, "tlsCa");
    const tlsCert = optionalField(fields, "tlsCert");
    const tlsKey = optionalField(fields, "tlsKey");
    if (tlsCa) result.tlsCa = tlsCa;
    if (tlsCert) result.tlsCert = tlsCert;
    if (tlsKey) result.tlsKey = tlsKey;

    return result;
  },
  exampleFields: ["SOCKET_PATH", "HOST", "PORT", "TLS", "TLS_CA", "TLS_CERT", "TLS_KEY"],
  buildActions,
};

export default dockerService;
