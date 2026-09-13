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
const getContainer = vi.fn(() => ({
  start: containerStart,
  stop: containerStop,
  restart: containerRestart,
  remove: containerRemove,
  logs: containerLogs,
  inspect: containerInspect,
}));

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
});
