import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import npmService from "../src/services/npm.js";
import type { InstanceConfig } from "../src/core/types.js";

const BASE_URL = "http://10.0.0.5:81";

function makeInstance(
  fields: Record<string, string> = { baseUrl: BASE_URL, identity: "admin@example.com", secret: "secretpw" }
): InstanceConfig {
  return { id: "default", fields };
}

function findAction(id: string) {
  const action = npmService.buildActions().find((a) => a.id === id);
  if (!action) throw new Error(`action ${id} not found`);
  return action;
}

describe("npm service", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("parseInstanceFields", () => {
    it("throws when baseUrl is missing", () => {
      expect(() => npmService.parseInstanceFields({ identity: "a", secret: "b" })).toThrow(/baseUrl|BASE_URL/i);
    });

    it("throws when identity is missing", () => {
      expect(() => npmService.parseInstanceFields({ baseUrl: BASE_URL, secret: "b" })).toThrow(/identity|IDENTITY/i);
    });

    it("throws when secret is missing", () => {
      expect(() => npmService.parseInstanceFields({ baseUrl: BASE_URL, identity: "a" })).toThrow(/secret|SECRET/i);
    });

    it("succeeds with valid fields and defaults insecureTls to false", () => {
      const result = npmService.parseInstanceFields({ baseUrl: BASE_URL, identity: "admin@example.com", secret: "pw" });
      expect(result.baseUrl).toBe(BASE_URL);
      expect(result.identity).toBe("admin@example.com");
      expect(result.secret).toBe("pw");
      expect(result.insecureTls).toBe("false");
    });

    it("normalizes insecureTls when provided as true", () => {
      const result = npmService.parseInstanceFields({
        baseUrl: BASE_URL,
        identity: "admin@example.com",
        secret: "pw",
        insecureTls: "true",
      });
      expect(result.insecureTls).toBe("true");
    });
  });

  describe("list_proxy_hosts", () => {
    it("logs in, uses the returned bearer token, and returns the proxy hosts", async () => {
      const hosts = [{ id: 1, domain_names: ["example.com"], forward_host: "10.0.0.10", forward_port: 8080 }];

      nock(BASE_URL)
        .post("/api/tokens", { identity: "admin@example.com", secret: "secretpw" })
        .reply(200, { token: "jwt-token-abc", expires: "2026-09-14T00:00:00.000Z" });

      nock(BASE_URL)
        .get("/api/nginx/proxy-hosts")
        .query({ expand: "owner,access_list,certificate" })
        .matchHeader("Authorization", "Bearer jwt-token-abc")
        .reply(200, hosts);

      const action = findAction("list_proxy_hosts");
      const instance = makeInstance();
      const result = await action.handler({}, instance);

      expect(result).toEqual(hosts);
    });

    it("surfaces the NPM error message when login fails", async () => {
      nock(BASE_URL)
        .post("/api/tokens", { identity: "admin@example.com", secret: "wrongpw" })
        .reply(401, { error: { code: 401, message: "Invalid credentials" } });

      const action = findAction("list_proxy_hosts");
      const instance = makeInstance({ baseUrl: BASE_URL, identity: "admin@example.com", secret: "wrongpw" });

      await expect(action.handler({}, instance)).rejects.toThrow(/Invalid credentials/);
    });
  });

  describe("create_proxy_host", () => {
    it("logs in and posts the mapped snake_case body", async () => {
      nock(BASE_URL)
        .post("/api/tokens")
        .reply(200, { token: "jwt-token-xyz", expires: "2026-09-14T00:00:00.000Z" });

      nock(BASE_URL)
        .post("/api/nginx/proxy-hosts", {
          domain_names: ["example.com"],
          forward_scheme: "http",
          forward_host: "10.0.0.10",
          forward_port: 8080,
          ssl_forced: false,
          caching_enabled: false,
          block_exploits: false,
          allow_websocket_upgrade: true,
          http2_support: false,
          certificate_id: 0,
          access_list_id: 0,
          advanced_config: "",
          meta: {},
        })
        .matchHeader("Authorization", "Bearer jwt-token-xyz")
        .reply(201, { id: 42, domain_names: ["example.com"] });

      const action = findAction("create_proxy_host");
      const instance = makeInstance();
      const result = await action.handler(
        { domainNames: ["example.com"], forwardHost: "10.0.0.10", forwardPort: 8080 },
        instance
      );

      expect(result).toEqual({ id: 42, domain_names: ["example.com"] });
    });
  });

  describe("delete_proxy_host", () => {
    it("logs in and deletes the host by id", async () => {
      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-del", expires: "2026-09-14T00:00:00.000Z" });

      nock(BASE_URL)
        .delete("/api/nginx/proxy-hosts/42")
        .matchHeader("Authorization", "Bearer jwt-token-del")
        .reply(200, true);

      const action = findAction("delete_proxy_host");
      const instance = makeInstance();
      const result = await action.handler({ hostId: 42 }, instance);

      expect(result).toBe(true);
    });
  });
});
