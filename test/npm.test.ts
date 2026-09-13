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

  describe("list_users", () => {
    it("logs in and returns the users", async () => {
      const users = [{ id: 1, name: "Admin User", email: "admin@example.com" }];

      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-users" });

      nock(BASE_URL)
        .get("/api/users")
        .matchHeader("Authorization", "Bearer jwt-token-users")
        .reply(200, users);

      const action = findAction("list_users");
      const instance = makeInstance();
      const result = await action.handler({}, instance);

      expect(result).toEqual(users);
    });
  });

  describe("create_user", () => {
    it("creates the user then sets their password auth, returning both results", async () => {
      nock(BASE_URL).post("/api/tokens").twice().reply(200, { token: "jwt-token-create-user" });

      nock(BASE_URL)
        .post("/api/users", {
          name: "Jane Doe",
          nickname: "jane",
          email: "jane@example.com",
          roles: ["admin"],
          is_disabled: false,
        })
        .matchHeader("Authorization", "Bearer jwt-token-create-user")
        .reply(201, { id: 7, name: "Jane Doe" });

      nock(BASE_URL)
        .post("/api/users/7/auth", { type: "password", secret: "s3cret!" })
        .matchHeader("Authorization", "Bearer jwt-token-create-user")
        .reply(201, { success: true });

      const action = findAction("create_user");
      const instance = makeInstance();
      const result = await action.handler(
        { name: "Jane Doe", nickname: "jane", email: "jane@example.com", password: "s3cret!", isAdmin: true },
        instance
      );

      expect(result).toEqual({ user: { id: 7, name: "Jane Doe" }, auth: { success: true } });
    });
  });

  describe("update_user", () => {
    it("puts only the provided fields, mapped to snake_case", async () => {
      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-update-user" });

      nock(BASE_URL)
        .put("/api/users/7", { nickname: "janed", is_disabled: true })
        .matchHeader("Authorization", "Bearer jwt-token-update-user")
        .reply(200, { id: 7, nickname: "janed", is_disabled: true });

      const action = findAction("update_user");
      const instance = makeInstance();
      const result = await action.handler({ userId: 7, nickname: "janed", isDisabled: true }, instance);

      expect(result).toEqual({ id: 7, nickname: "janed", is_disabled: true });
    });
  });

  describe("delete_user", () => {
    it("deletes the user by id", async () => {
      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-del-user" });

      nock(BASE_URL)
        .delete("/api/users/7")
        .matchHeader("Authorization", "Bearer jwt-token-del-user")
        .reply(200, true);

      const action = findAction("delete_user");
      const instance = makeInstance();
      const result = await action.handler({ userId: 7 }, instance);

      expect(result).toBe(true);
    });

    it("surfaces the NPM error message on failure", async () => {
      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-del-user-err" });

      nock(BASE_URL)
        .delete("/api/users/7")
        .matchHeader("Authorization", "Bearer jwt-token-del-user-err")
        .reply(403, { error: { code: 403, message: "Cannot delete yourself" } });

      const action = findAction("delete_user");
      const instance = makeInstance();

      await expect(action.handler({ userId: 7 }, instance)).rejects.toThrow(/Cannot delete yourself/);
    });
  });

  describe("list_dead_hosts", () => {
    it("logs in and returns the dead hosts", async () => {
      const hosts = [{ id: 3, domain_names: ["404.example.com"] }];

      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-dead-hosts" });

      nock(BASE_URL)
        .get("/api/nginx/dead-hosts")
        .matchHeader("Authorization", "Bearer jwt-token-dead-hosts")
        .reply(200, hosts);

      const action = findAction("list_dead_hosts");
      const instance = makeInstance();
      const result = await action.handler({}, instance);

      expect(result).toEqual(hosts);
    });
  });

  describe("list_settings", () => {
    it("logs in and returns the settings", async () => {
      const settings = [{ id: "default-site", name: "Default Site", value: "congratulations" }];

      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-settings" });

      nock(BASE_URL)
        .get("/api/settings")
        .matchHeader("Authorization", "Bearer jwt-token-settings")
        .reply(200, settings);

      const action = findAction("list_settings");
      const instance = makeInstance();
      const result = await action.handler({}, instance);

      expect(result).toEqual(settings);
    });
  });

  describe("update_setting", () => {
    it("puts the value and meta for the given setting id", async () => {
      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-update-setting" });

      nock(BASE_URL)
        .put("/api/settings/default-site", { value: "redirect", meta: { redirect: "https://example.com" } })
        .matchHeader("Authorization", "Bearer jwt-token-update-setting")
        .reply(200, { id: "default-site", value: "redirect" });

      const action = findAction("update_setting");
      const instance = makeInstance();
      const result = await action.handler(
        { settingId: "default-site", value: "redirect", meta: { redirect: "https://example.com" } },
        instance
      );

      expect(result).toEqual({ id: "default-site", value: "redirect" });
    });
  });

  describe("request_letsencrypt_certificate", () => {
    it("posts the letsencrypt certificate request with defaults", async () => {
      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-cert" });

      nock(BASE_URL)
        .post("/api/nginx/certificates", {
          provider: "letsencrypt",
          domain_names: ["example.com"],
          meta: { letsencrypt_email: "admin@example.com", letsencrypt_agree: true, dns_challenge: false },
        })
        .matchHeader("Authorization", "Bearer jwt-token-cert")
        .reply(201, { id: 9, domain_names: ["example.com"] });

      const action = findAction("request_letsencrypt_certificate");
      const instance = makeInstance();
      const result = await action.handler(
        { domainNames: ["example.com"], email: "admin@example.com" },
        instance
      );

      expect(result).toEqual({ id: 9, domain_names: ["example.com"] });
    });
  });

  describe("delete_certificate", () => {
    it("deletes the certificate by id", async () => {
      nock(BASE_URL).post("/api/tokens").reply(200, { token: "jwt-token-del-cert" });

      nock(BASE_URL)
        .delete("/api/nginx/certificates/9")
        .matchHeader("Authorization", "Bearer jwt-token-del-cert")
        .reply(200, true);

      const action = findAction("delete_certificate");
      const instance = makeInstance();
      const result = await action.handler({ certificateId: 9 }, instance);

      expect(result).toBe(true);
    });
  });
});
