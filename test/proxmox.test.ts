import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import proxmoxService from "../src/services/proxmox.js";
import type { InstanceConfig } from "../src/core/types.js";

const BASE_URL = "https://10.0.0.5:8006";

function findAction(id: string) {
  const action = proxmoxService.buildActions().find((a) => a.id === id);
  if (!action) throw new Error(`action ${id} not found`);
  return action;
}

function makeInstance(fields: Record<string, string>): InstanceConfig {
  return { id: "default", fields };
}

const validFields = {
  baseUrl: "https://10.0.0.5:8006",
  tokenId: "root@pam!mcp",
  tokenSecret: "abcd-1234-secret",
};

describe("proxmox service", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("parseInstanceFields", () => {
    it("throws when baseUrl is missing", () => {
      expect(() =>
        proxmoxService.parseInstanceFields({ tokenId: "root@pam!mcp", tokenSecret: "secret" })
      ).toThrow(/baseUrl|BASE_URL/i);
    });

    it("throws when tokenId is missing", () => {
      expect(() =>
        proxmoxService.parseInstanceFields({ baseUrl: "https://10.0.0.5:8006", tokenSecret: "secret" })
      ).toThrow(/tokenId|TOKEN_ID/i);
    });

    it("throws when tokenSecret is missing", () => {
      expect(() =>
        proxmoxService.parseInstanceFields({ baseUrl: "https://10.0.0.5:8006", tokenId: "root@pam!mcp" })
      ).toThrow(/tokenSecret|TOKEN_SECRET/i);
    });

    it("succeeds with valid fields, strips trailing slash, and defaults insecureTls to unset", () => {
      const result = proxmoxService.parseInstanceFields({
        baseUrl: "https://10.0.0.5:8006/",
        tokenId: "root@pam!mcp",
        tokenSecret: "secret-uuid",
      });
      expect(result.baseUrl).toBe("https://10.0.0.5:8006");
      expect(result.tokenId).toBe("root@pam!mcp");
      expect(result.tokenSecret).toBe("secret-uuid");
      expect(result.insecureTls).toBeUndefined();
    });

    it("parses insecureTls=true", () => {
      const result = proxmoxService.parseInstanceFields({ ...validFields, insecureTls: "true" });
      expect(result.insecureTls).toBe("true");
    });

    it("parses insecureTls=false explicitly", () => {
      const result = proxmoxService.parseInstanceFields({ ...validFields, insecureTls: "false" });
      expect(result.insecureTls).toBe("false");
    });
  });

  describe("list_nodes", () => {
    it("returns node summaries with the correct PVEAPIToken auth header", async () => {
      const nodes = [
        { node: "pve1", status: "online", cpu: 0.05, mem: 1000, maxmem: 8000, uptime: 12345 },
        { node: "pve2", status: "online", cpu: 0.1, mem: 2000, maxmem: 8000, uptime: 6789 },
      ];
      const scope = nock(BASE_URL, {
        reqheaders: {
          authorization: "PVEAPIToken=root@pam!mcp=abcd-1234-secret",
        },
      })
        .get("/api2/json/nodes")
        .reply(200, { data: nodes });

      const action = findAction("list_nodes");
      const instance = makeInstance(validFields);
      const result = await action.handler({}, instance);

      expect(result).toEqual(nodes);
      expect(scope.isDone()).toBe(true);
    });
  });

  describe("start_guest", () => {
    it("posts to the correct qemu status/start path and returns the upid", async () => {
      const upid = "UPID:pve1:00001234:00ABCDEF:12345678:qmstart:100:root@pam!mcp:";
      nock(BASE_URL)
        .post("/api2/json/nodes/pve1/qemu/100/status/start")
        .reply(200, { data: upid });

      const action = findAction("start_guest");
      const instance = makeInstance(validFields);
      const result = await action.handler({ node: "pve1", vmid: 100, type: "qemu" }, instance);

      expect(result).toEqual({ upid });
    });

    it("posts to the correct lxc status/start path", async () => {
      const upid = "UPID:pve1:00001235:00ABCDEF:12345678:vzstart:101:root@pam!mcp:";
      nock(BASE_URL)
        .post("/api2/json/nodes/pve1/lxc/101/status/start")
        .reply(200, { data: upid });

      const action = findAction("start_guest");
      const instance = makeInstance(validFields);
      const result = await action.handler({ node: "pve1", vmid: 101, type: "lxc" }, instance);

      expect(result).toEqual({ upid });
    });
  });

  describe("list_guests", () => {
    it("aggregates qemu and lxc guests across all nodes when node is omitted", async () => {
      nock(BASE_URL)
        .get("/api2/json/nodes")
        .reply(200, { data: [{ node: "pve1" }, { node: "pve2" }] });
      nock(BASE_URL)
        .get("/api2/json/nodes/pve1/qemu")
        .reply(200, { data: [{ vmid: 100, name: "vm100" }] });
      nock(BASE_URL)
        .get("/api2/json/nodes/pve1/lxc")
        .reply(200, { data: [{ vmid: 101, name: "ct101" }] });
      nock(BASE_URL)
        .get("/api2/json/nodes/pve2/qemu")
        .reply(200, { data: [] });
      nock(BASE_URL)
        .get("/api2/json/nodes/pve2/lxc")
        .reply(200, { data: [] });

      const action = findAction("list_guests");
      const instance = makeInstance(validFields);
      const result = await action.handler({}, instance);

      expect(result).toEqual([
        { vmid: 100, name: "vm100", node: "pve1", type: "qemu" },
        { vmid: 101, name: "ct101", node: "pve1", type: "lxc" },
      ]);
    });

    it("only fetches the requested type on the given node", async () => {
      nock(BASE_URL)
        .get("/api2/json/nodes/pve1/qemu")
        .reply(200, { data: [{ vmid: 100, name: "vm100" }] });

      const action = findAction("list_guests");
      const instance = makeInstance(validFields);
      const result = await action.handler({ node: "pve1", type: "qemu" }, instance);

      expect(result).toEqual([{ vmid: 100, name: "vm100", node: "pve1", type: "qemu" }]);
    });
  });

  describe("error handling", () => {
    it("throws a descriptive error including the response body on non-2xx status", async () => {
      nock(BASE_URL)
        .get("/api2/json/nodes/pve1/qemu/999/status/current")
        .reply(500, { data: null, errors: { vmid: "Configuration file does not exist" } });

      const action = findAction("get_guest_status");
      const instance = makeInstance(validFields);

      await expect(
        action.handler({ node: "pve1", vmid: 999, type: "qemu" }, instance)
      ).rejects.toThrow(/get_guest_status failed with HTTP 500.*Configuration file does not exist/s);
    });
  });
});
