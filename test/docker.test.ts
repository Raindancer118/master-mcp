import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceConfig } from "../src/core/types.js";

const listContainers = vi.fn();
const listImages = vi.fn();
const listVolumes = vi.fn();
const listNetworks = vi.fn();
const infoMock = vi.fn();
const pullMock = vi.fn();
const followProgress = vi.fn();

const containerStart = vi.fn();
const containerStop = vi.fn();
const containerRestart = vi.fn();
const containerRemove = vi.fn();
const containerLogs = vi.fn();
const containerInspect = vi.fn();
const containerRename = vi.fn();
const containerStats = vi.fn();
const containerTop = vi.fn();
const getContainer = vi.fn(() => ({
  start: containerStart,
  stop: containerStop,
  restart: containerRestart,
  remove: containerRemove,
  logs: containerLogs,
  inspect: containerInspect,
  rename: containerRename,
  stats: containerStats,
  top: containerTop,
}));

const createContainerMock = vi.fn();
const pruneContainersMock = vi.fn();
const imageRemove = vi.fn();
const imageTag = vi.fn();
const getImageMock = vi.fn(() => ({ remove: imageRemove, tag: imageTag }));
const pruneImagesMock = vi.fn();
const createNetworkMock = vi.fn();
const networkRemove = vi.fn();
const getNetworkMock = vi.fn(() => ({ remove: networkRemove }));
const createVolumeMock = vi.fn();
const volumeRemove = vi.fn();
const getVolumeMock = vi.fn(() => ({ remove: volumeRemove }));
const pruneVolumesMock = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      listContainers,
      listImages,
      listVolumes,
      listNetworks,
      info: infoMock,
      pull: pullMock,
      getContainer,
      createContainer: createContainerMock,
      pruneContainers: pruneContainersMock,
      getImage: getImageMock,
      pruneImages: pruneImagesMock,
      createNetwork: createNetworkMock,
      getNetwork: getNetworkMock,
      createVolume: createVolumeMock,
      getVolume: getVolumeMock,
      pruneVolumes: pruneVolumesMock,
      modem: { followProgress },
    })),
  };
});

const dockerServiceModule = await import("../src/services/docker.js");
const dockerService = dockerServiceModule.default;

function findAction(id: string) {
  const action = dockerService.buildActions().find((a) => a.id === id);
  if (!action) throw new Error(`action ${id} not found`);
  return action;
}

function makeInstance(fields: Record<string, string>): InstanceConfig {
  return { id: "default", fields };
}

describe("docker service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseInstanceFields", () => {
    it("throws when neither socketPath nor host is given", () => {
      expect(() => dockerService.parseInstanceFields({})).toThrow(/socketPath|host/i);
    });

    it("throws when both socketPath and host are given", () => {
      expect(() =>
        dockerService.parseInstanceFields({ socketPath: "/var/run/docker.sock", host: "1.2.3.4" })
      ).toThrow(/ambiguous/i);
    });

    it("succeeds with just socketPath", () => {
      const result = dockerService.parseInstanceFields({ socketPath: "/var/run/docker.sock" });
      expect(result).toEqual({ socketPath: "/var/run/docker.sock" });
    });

    it("succeeds with just host and port", () => {
      const result = dockerService.parseInstanceFields({ host: "1.2.3.4", port: "2375" });
      expect(result).toEqual({ host: "1.2.3.4", port: "2375" });
    });

    it("throws when port is not numeric", () => {
      expect(() => dockerService.parseInstanceFields({ host: "1.2.3.4", port: "abc" })).toThrow(/numeric/i);
    });

    it("throws when tls is not true/false", () => {
      expect(() => dockerService.parseInstanceFields({ host: "1.2.3.4", tls: "yes" })).toThrow(/tls/i);
    });
  });

  describe("list_containers", () => {
    it("calls listContainers and returns a trimmed mapping", async () => {
      listContainers.mockResolvedValue([
        {
          Id: "abc123",
          Names: ["/my-app"],
          Image: "nginx:latest",
          State: "running",
          Status: "Up 2 hours",
          Ports: [{ IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
          Command: "nginx -g daemon off;",
          Created: 12345,
          Labels: {},
          HostConfig: { NetworkMode: "bridge" },
          NetworkSettings: { Networks: {} },
          Mounts: [],
        },
      ]);

      const action = findAction("list_containers");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });
      const result = await action.handler({}, instance);

      expect(listContainers).toHaveBeenCalledWith({ all: true });
      expect(result).toEqual([
        {
          id: "abc123",
          names: ["/my-app"],
          image: "nginx:latest",
          state: "running",
          status: "Up 2 hours",
          ports: [{ IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
        },
      ]);
    });

    it("passes all:false through when requested", async () => {
      listContainers.mockResolvedValue([]);
      const action = findAction("list_containers");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });
      await action.handler({ all: false }, instance);
      expect(listContainers).toHaveBeenCalledWith({ all: false });
    });
  });

  describe("stop_container", () => {
    it("calls the container's stop method with a timeout when given", async () => {
      containerStop.mockResolvedValue(undefined);
      const action = findAction("stop_container");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });

      const result = await action.handler({ containerId: "abc123", timeoutSeconds: 10 }, instance);

      expect(getContainer).toHaveBeenCalledWith("abc123");
      expect(containerStop).toHaveBeenCalledWith({ t: 10 });
      expect(result).toEqual({ success: true, containerId: "abc123" });
    });

    it("calls stop with no options when no timeout is given", async () => {
      containerStop.mockResolvedValue(undefined);
      const action = findAction("stop_container");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });

      await action.handler({ containerId: "abc123" }, instance);

      expect(containerStop).toHaveBeenCalledWith({});
    });

    it("surfaces a clear error when the daemon call rejects", async () => {
      containerStop.mockRejectedValue(new Error("no such container: abc123"));
      const action = findAction("stop_container");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });

      await expect(action.handler({ containerId: "abc123" }, instance)).rejects.toThrow(/no such container/);
    });
  });

  describe("container_logs", () => {
    it("demuxes multiplexed stdout/stderr frames into plain text", async () => {
      const stdoutPayload = Buffer.from("hello from stdout\n", "utf8");
      const stderrPayload = Buffer.from("oops from stderr\n", "utf8");
      const stdoutHeader = Buffer.alloc(8);
      stdoutHeader.writeUInt8(1, 0);
      stdoutHeader.writeUInt32BE(stdoutPayload.length, 4);
      const stderrHeader = Buffer.alloc(8);
      stderrHeader.writeUInt8(2, 0);
      stderrHeader.writeUInt32BE(stderrPayload.length, 4);
      const buffer = Buffer.concat([stdoutHeader, stdoutPayload, stderrHeader, stderrPayload]);

      containerLogs.mockResolvedValue(buffer);
      const action = findAction("container_logs");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });

      const result = await action.handler({ containerId: "abc123" }, instance);

      expect(containerLogs).toHaveBeenCalledWith({
        stdout: true,
        stderr: true,
        tail: 200,
        timestamps: true,
        follow: false,
      });
      expect(result).toBe("hello from stdout\noops from stderr\n");
    });

    it("falls back to raw text for a non-multiplexed (TTY) buffer", async () => {
      const buffer = Buffer.from("plain tty output, no frame headers", "utf8");
      containerLogs.mockResolvedValue(buffer);
      const action = findAction("container_logs");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });

      const result = await action.handler({ containerId: "abc123", tail: 50 }, instance);

      expect(containerLogs).toHaveBeenCalledWith(
        expect.objectContaining({ tail: 50 })
      );
      expect(result).toBe("plain tty output, no frame headers");
    });
  });

  describe("pull_image", () => {
    it("pulls the image and awaits followProgress before resolving", async () => {
      const fakeStream = { on: vi.fn() };
      pullMock.mockResolvedValue(fakeStream);
      followProgress.mockImplementation((_stream: unknown, cb: (err: Error | null) => void) => cb(null));

      const action = findAction("pull_image");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });
      const result = await action.handler({ image: "nginx" }, instance);

      expect(pullMock).toHaveBeenCalledWith("nginx:latest");
      expect(followProgress).toHaveBeenCalled();
      expect(result).toEqual({ success: true, image: "nginx:latest" });
    });

    it("uses the given tag instead of latest", async () => {
      const fakeStream = { on: vi.fn() };
      pullMock.mockResolvedValue(fakeStream);
      followProgress.mockImplementation((_stream: unknown, cb: (err: Error | null) => void) => cb(null));

      const action = findAction("pull_image");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });
      const result = await action.handler({ image: "nginx", tag: "1.27" }, instance);

      expect(pullMock).toHaveBeenCalledWith("nginx:1.27");
      expect(result).toEqual({ success: true, image: "nginx:1.27" });
    });

    it("rejects when followProgress reports an error", async () => {
      const fakeStream = { on: vi.fn() };
      pullMock.mockResolvedValue(fakeStream);
      followProgress.mockImplementation((_stream: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("manifest unknown"))
      );

      const action = findAction("pull_image");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });

      await expect(action.handler({ image: "no-such-image" }, instance)).rejects.toThrow(/manifest unknown/);
    });
  });

  describe("docker_info", () => {
    it("returns a compact summary of the daemon info", async () => {
      infoMock.mockResolvedValue({
        ID: "ABCD:1234",
        Containers: 5,
        ContainersRunning: 3,
        ContainersPaused: 0,
        ContainersStopped: 2,
        Images: 10,
        ServerVersion: "27.0.0",
        OperatingSystem: "Alpine Linux",
        NCPU: 4,
        MemTotal: 8_000_000_000,
        DockerRootDir: "/var/lib/docker",
        SomethingHuge: "irrelevant",
      });

      const action = findAction("docker_info");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });
      const result = await action.handler({}, instance);

      expect(result).toEqual({
        id: "ABCD:1234",
        containers: 5,
        containersRunning: 3,
        containersPaused: 0,
        containersStopped: 2,
        images: 10,
        serverVersion: "27.0.0",
        operatingSystem: "Alpine Linux",
        ncpu: 4,
        memTotal: 8_000_000_000,
        dockerRootDir: "/var/lib/docker",
      });
    });
  });

  describe("remove_container", () => {
    it("maps force/removeVolumes to dockerode's force/v", async () => {
      containerRemove.mockResolvedValue(undefined);
      const action = findAction("remove_container");
      const instance = makeInstance({ socketPath: "/var/run/docker.sock" });

      await action.handler({ containerId: "abc123", force: true, removeVolumes: true }, instance);

      expect(containerRemove).toHaveBeenCalledWith({ force: true, v: true });
    });
  });

  const instance = () => makeInstance({ socketPath: "/var/run/docker.sock" });

  describe("rename_container", () => {
    it("calls the container's rename method", async () => {
      containerRename.mockResolvedValue(undefined);
      const action = findAction("rename_container");

      const result = await action.handler({ containerId: "abc123", newName: "web-2" }, instance());

      expect(containerRename).toHaveBeenCalledWith({ name: "web-2" });
      expect(result).toEqual({ success: true, containerId: "abc123", newName: "web-2" });
    });
  });

  describe("container_stats", () => {
    it("computes cpu percent and trims the raw stats snapshot", async () => {
      containerStats.mockResolvedValue({
        cpu_stats: {
          cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2] },
          system_cpu_usage: 10_000_000_000,
          online_cpus: 2,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 1_000_000_000 },
          system_cpu_usage: 8_000_000_000,
        },
        memory_stats: { usage: 104_857_600, limit: 1_073_741_824 },
        networks: {
          eth0: { rx_bytes: 1000, tx_bytes: 500 },
          eth1: { rx_bytes: 200, tx_bytes: 100 },
        },
      });

      const action = findAction("container_stats");
      const result = await action.handler({ containerId: "abc123" }, instance());

      // cpuDelta=1e9, systemDelta=2e9 -> (1e9/2e9)*2*100 = 100
      expect(result).toEqual({
        cpuPercent: 100,
        memoryUsage: 104_857_600,
        memoryLimit: 1_073_741_824,
        networkRxBytes: 1200,
        networkTxBytes: 600,
      });
    });
  });

  describe("container_processes", () => {
    it("returns the container's top output", async () => {
      const topResult = { Titles: ["PID", "CMD"], Processes: [["1", "nginx"]] };
      containerTop.mockResolvedValue(topResult);

      const action = findAction("container_processes");
      const result = await action.handler({ containerId: "abc123" }, instance());

      expect(containerTop).toHaveBeenCalled();
      expect(result).toEqual(topResult);
    });
  });

  describe("create_container", () => {
    it("creates the container with mapped host config and starts it by default", async () => {
      createContainerMock.mockResolvedValue({ id: "newid123", start: containerStart });
      containerStart.mockResolvedValue(undefined);

      const action = findAction("create_container");
      const result = await action.handler(
        {
          image: "nginx:latest",
          name: "web",
          env: ["FOO=bar"],
          ports: { "80/tcp": "8080" },
          volumes: ["/host:/container"],
          command: ["nginx", "-g", "daemon off;"],
          restartPolicy: "always",
        },
        instance()
      );

      expect(createContainerMock).toHaveBeenCalledWith({
        Image: "nginx:latest",
        name: "web",
        Env: ["FOO=bar"],
        Cmd: ["nginx", "-g", "daemon off;"],
        HostConfig: {
          PortBindings: { "80/tcp": [{ HostPort: "8080" }] },
          Binds: ["/host:/container"],
          RestartPolicy: { Name: "always" },
        },
      });
      expect(containerStart).toHaveBeenCalled();
      expect(result).toEqual({ success: true, containerId: "newid123", name: "web" });
    });

    it("does not start the container when start:false", async () => {
      createContainerMock.mockResolvedValue({ id: "newid456", start: containerStart });

      const action = findAction("create_container");
      await action.handler({ image: "redis:latest", start: false }, instance());

      expect(containerStart).not.toHaveBeenCalled();
    });
  });

  describe("prune_containers", () => {
    it("calls pruneContainers and returns its result", async () => {
      const pruneResult = { ContainersDeleted: ["a", "b"], SpaceReclaimed: 1024 };
      pruneContainersMock.mockResolvedValue(pruneResult);

      const action = findAction("prune_containers");
      const result = await action.handler({}, instance());

      expect(result).toEqual(pruneResult);
    });
  });

  describe("remove_image", () => {
    it("removes the image by ref with the force flag", async () => {
      imageRemove.mockResolvedValue(undefined);

      const action = findAction("remove_image");
      const result = await action.handler({ image: "nginx:old", force: true }, instance());

      expect(getImageMock).toHaveBeenCalledWith("nginx:old");
      expect(imageRemove).toHaveBeenCalledWith({ force: true });
      expect(result).toEqual({ success: true, image: "nginx:old" });
    });
  });

  describe("tag_image", () => {
    it("tags the image, defaulting tag to latest", async () => {
      imageTag.mockResolvedValue(undefined);

      const action = findAction("tag_image");
      const result = await action.handler({ image: "nginx:old", repo: "myrepo/nginx" }, instance());

      expect(imageTag).toHaveBeenCalledWith({ repo: "myrepo/nginx", tag: "latest" });
      expect(result).toEqual({ success: true, image: "nginx:old", repo: "myrepo/nginx", tag: "latest" });
    });
  });

  describe("prune_images", () => {
    it("prunes dangling images by default", async () => {
      const pruneResult = { ImagesDeleted: [], SpaceReclaimed: 0 };
      pruneImagesMock.mockResolvedValue(pruneResult);

      const action = findAction("prune_images");
      const result = await action.handler({}, instance());

      expect(pruneImagesMock).toHaveBeenCalledWith({ filters: { dangling: ["true"] } });
      expect(result).toEqual(pruneResult);
    });
  });

  describe("create_network", () => {
    it("creates a bridge network by default", async () => {
      createNetworkMock.mockResolvedValue({ id: "net123" });

      const action = findAction("create_network");
      const result = await action.handler({ name: "my-net" }, instance());

      expect(createNetworkMock).toHaveBeenCalledWith({ Name: "my-net", Driver: "bridge" });
      expect(result).toEqual({ success: true, name: "my-net", id: "net123" });
    });
  });

  describe("remove_network", () => {
    it("removes the network by id", async () => {
      networkRemove.mockResolvedValue(undefined);

      const action = findAction("remove_network");
      const result = await action.handler({ networkId: "net123" }, instance());

      expect(getNetworkMock).toHaveBeenCalledWith("net123");
      expect(result).toEqual({ success: true, networkId: "net123" });
    });
  });

  describe("create_volume", () => {
    it("creates a local volume by default", async () => {
      const volumeResult = { Name: "my-vol", Driver: "local" };
      createVolumeMock.mockResolvedValue(volumeResult);

      const action = findAction("create_volume");
      const result = await action.handler({ name: "my-vol" }, instance());

      expect(createVolumeMock).toHaveBeenCalledWith({ Name: "my-vol", Driver: "local" });
      expect(result).toEqual(volumeResult);
    });
  });

  describe("remove_volume", () => {
    it("removes the volume by name with the force flag", async () => {
      volumeRemove.mockResolvedValue(undefined);

      const action = findAction("remove_volume");
      const result = await action.handler({ name: "my-vol", force: true }, instance());

      expect(getVolumeMock).toHaveBeenCalledWith("my-vol");
      expect(volumeRemove).toHaveBeenCalledWith({ force: true });
      expect(result).toEqual({ success: true, name: "my-vol" });
    });
  });

  describe("prune_volumes", () => {
    it("calls pruneVolumes and returns its result", async () => {
      const pruneResult = { VolumesDeleted: ["my-vol"], SpaceReclaimed: 2048 };
      pruneVolumesMock.mockResolvedValue(pruneResult);

      const action = findAction("prune_volumes");
      const result = await action.handler({}, instance());

      expect(result).toEqual(pruneResult);
    });
  });
});
