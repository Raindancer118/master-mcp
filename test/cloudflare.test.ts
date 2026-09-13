import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import cloudflareService from "../src/services/cloudflare.js";
import type { InstanceConfig } from "../src/core/types.js";

const BASE_URL = "https://api.cloudflare.com";

function findAction(id: string) {
  const action = cloudflareService.buildActions().find((a) => a.id === id);
  if (!action) throw new Error(`action ${id} not found`);
  return action;
}

function makeInstance(fields: Record<string, string>): InstanceConfig {
  return { id: "default", fields };
}

describe("cloudflare service", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("parseInstanceFields", () => {
    it("throws when apiToken is missing", () => {
      expect(() => cloudflareService.parseInstanceFields({})).toThrow(/apiToken|API_TOKEN/i);
    });

    it("succeeds with a valid apiToken and returns normalized fields", () => {
      const result = cloudflareService.parseInstanceFields({ apiToken: "tok_123" });
      expect(result.apiToken).toBe("tok_123");
      expect(result.accountId).toBeUndefined();
    });

    it("includes accountId when provided", () => {
      const result = cloudflareService.parseInstanceFields({ apiToken: "tok_123", accountId: "acc_1" });
      expect(result.apiToken).toBe("tok_123");
      expect(result.accountId).toBe("acc_1");
    });
  });

  describe("list_zones", () => {
    it("returns parsed zones on success", async () => {
      const zones = [
        { id: "zone1", name: "example.com", status: "active", paused: false, name_servers: ["ns1.cf", "ns2.cf"] },
      ];
      nock(BASE_URL)
        .get("/client/v4/zones")
        .query({ per_page: "20" })
        .reply(200, { success: true, result: zones, errors: [], messages: [] });

      const action = findAction("list_zones");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({}, instance);

      expect(result).toEqual(zones);
    });

    it("throws with the Cloudflare error message when the API reports failure", async () => {
      nock(BASE_URL)
        .get("/client/v4/zones")
        .query({ per_page: "20" })
        .reply(200, {
          success: false,
          result: null,
          errors: [{ code: 9109, message: "Invalid access token" }],
          messages: [],
        });

      const action = findAction("list_zones");
      const instance = makeInstance({ apiToken: "bad_token" });

      await expect(action.handler({}, instance)).rejects.toThrow(/Invalid access token/);
    });

    it("throws on non-2xx HTTP status", async () => {
      nock(BASE_URL)
        .get("/client/v4/zones")
        .query({ per_page: "20" })
        .reply(403, { success: false, errors: [{ message: "Forbidden" }] });

      const action = findAction("list_zones");
      const instance = makeInstance({ apiToken: "tok_123" });

      await expect(action.handler({}, instance)).rejects.toThrow(/list_zones failed with HTTP 403/);
    });
  });

  describe("delete_dns_record", () => {
    it("deletes a record successfully", async () => {
      nock(BASE_URL)
        .delete("/client/v4/zones/zone1/dns_records/rec1")
        .reply(200, { success: true, result: { id: "rec1" }, errors: [], messages: [] });

      const action = findAction("delete_dns_record");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1", recordId: "rec1" }, instance);

      expect(result).toEqual({ id: "rec1" });
    });
  });

  describe("purge_cache", () => {
    it("throws a clear error when neither files nor purgeEverything is set", async () => {
      const action = findAction("purge_cache");
      const instance = makeInstance({ apiToken: "tok_123" });

      await expect(action.handler({ zoneId: "zone1" }, instance)).rejects.toThrow(/requires either/);
    });

    it("throws a clear error when both files and purgeEverything are set", async () => {
      const action = findAction("purge_cache");
      const instance = makeInstance({ apiToken: "tok_123" });

      await expect(
        action.handler({ zoneId: "zone1", files: ["https://example.com/a.js"], purgeEverything: true }, instance)
      ).rejects.toThrow(/not both/);
    });

    it("purges everything when purgeEverything is set", async () => {
      nock(BASE_URL)
        .post("/client/v4/zones/zone1/purge_cache", { purge_everything: true })
        .reply(200, { success: true, result: { id: "zone1" }, errors: [], messages: [] });

      const action = findAction("purge_cache");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1", purgeEverything: true }, instance);

      expect(result).toEqual({ id: "zone1" });
    });
  });

  describe("get_zone_settings", () => {
    it("returns the settings array on success", async () => {
      const settings = [{ id: "ssl", value: "full" }];
      nock(BASE_URL)
        .get("/client/v4/zones/zone1/settings")
        .reply(200, { success: true, result: settings, errors: [], messages: [] });

      const action = findAction("get_zone_settings");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1" }, instance);

      expect(result).toEqual(settings);
    });
  });

  describe("update_zone_setting", () => {
    it("patches the given setting with the value body", async () => {
      nock(BASE_URL)
        .patch("/client/v4/zones/zone1/settings/ssl", { value: "strict" })
        .reply(200, { success: true, result: { id: "ssl", value: "strict" }, errors: [], messages: [] });

      const action = findAction("update_zone_setting");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1", settingId: "ssl", value: "strict" }, instance);

      expect(result).toEqual({ id: "ssl", value: "strict" });
    });

    it("throws with the Cloudflare error message when the API reports failure", async () => {
      nock(BASE_URL)
        .patch("/client/v4/zones/zone1/settings/ssl", { value: "strict" })
        .reply(200, {
          success: false,
          result: null,
          errors: [{ code: 1000, message: "Invalid setting value" }],
          messages: [],
        });

      const action = findAction("update_zone_setting");
      const instance = makeInstance({ apiToken: "tok_123" });

      await expect(
        action.handler({ zoneId: "zone1", settingId: "ssl", value: "strict" }, instance)
      ).rejects.toThrow(/Invalid setting value/);
    });
  });

  describe("list_page_rules", () => {
    it("returns page rules on success", async () => {
      const rules = [{ id: "pr1", targets: [], actions: [] }];
      nock(BASE_URL)
        .get("/client/v4/zones/zone1/pagerules")
        .reply(200, { success: true, result: rules, errors: [], messages: [] });

      const action = findAction("list_page_rules");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1" }, instance);

      expect(result).toEqual(rules);
    });
  });

  describe("create_page_rule", () => {
    it("posts targets/actions/priority/status derived from params", async () => {
      nock(BASE_URL)
        .post("/client/v4/zones/zone1/pagerules", {
          targets: [{ target: "url", constraint: { operator: "matches", value: "example.com/*" } }],
          actions: [{ id: "always_use_https" }],
          priority: 1,
          status: "active",
        })
        .reply(200, { success: true, result: { id: "pr1" }, errors: [], messages: [] });

      const action = findAction("create_page_rule");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler(
        { zoneId: "zone1", targetUrl: "example.com/*", actions: [{ id: "always_use_https" }], priority: 1 },
        instance
      );

      expect(result).toEqual({ id: "pr1" });
    });
  });

  describe("delete_page_rule", () => {
    it("deletes a page rule successfully", async () => {
      nock(BASE_URL)
        .delete("/client/v4/zones/zone1/pagerules/pr1")
        .reply(200, { success: true, result: { id: "pr1" }, errors: [], messages: [] });

      const action = findAction("delete_page_rule");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1", pageRuleId: "pr1" }, instance);

      expect(result).toEqual({ id: "pr1" });
    });
  });

  describe("list_ip_access_rules", () => {
    it("returns access rules on success", async () => {
      const rules = [{ id: "ar1", mode: "block" }];
      nock(BASE_URL)
        .get("/client/v4/zones/zone1/firewall/access_rules/rules")
        .reply(200, { success: true, result: rules, errors: [], messages: [] });

      const action = findAction("list_ip_access_rules");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1" }, instance);

      expect(result).toEqual(rules);
    });
  });

  describe("create_ip_access_rule", () => {
    it("posts mode/configuration/notes derived from params", async () => {
      nock(BASE_URL)
        .post("/client/v4/zones/zone1/firewall/access_rules/rules", {
          mode: "block",
          configuration: { target: "ip", value: "1.2.3.4" },
          notes: "bad actor",
        })
        .reply(200, { success: true, result: { id: "ar1" }, errors: [], messages: [] });

      const action = findAction("create_ip_access_rule");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler(
        { zoneId: "zone1", mode: "block", target: "ip", value: "1.2.3.4", notes: "bad actor" },
        instance
      );

      expect(result).toEqual({ id: "ar1" });
    });
  });

  describe("delete_ip_access_rule", () => {
    it("deletes an access rule successfully", async () => {
      nock(BASE_URL)
        .delete("/client/v4/zones/zone1/firewall/access_rules/rules/ar1")
        .reply(200, { success: true, result: { id: "ar1" }, errors: [], messages: [] });

      const action = findAction("delete_ip_access_rule");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1", ruleId: "ar1" }, instance);

      expect(result).toEqual({ id: "ar1" });
    });
  });

  describe("list_certificate_packs", () => {
    it("returns certificate packs on success", async () => {
      const packs = [{ id: "cp1", type: "advanced" }];
      nock(BASE_URL)
        .get("/client/v4/zones/zone1/ssl/certificate_packs")
        .reply(200, { success: true, result: packs, errors: [], messages: [] });

      const action = findAction("list_certificate_packs");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1" }, instance);

      expect(result).toEqual(packs);
    });
  });

  describe("list_custom_hostnames", () => {
    it("returns custom hostnames on success", async () => {
      const hostnames = [{ id: "ch1", hostname: "app.example.com" }];
      nock(BASE_URL)
        .get("/client/v4/zones/zone1/custom_hostnames")
        .query({ per_page: "20" })
        .reply(200, { success: true, result: hostnames, errors: [], messages: [] });

      const action = findAction("list_custom_hostnames");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1" }, instance);

      expect(result).toEqual(hostnames);
    });
  });

  describe("create_custom_hostname", () => {
    it("posts hostname/ssl derived from params, defaulting ssl method to http", async () => {
      nock(BASE_URL)
        .post("/client/v4/zones/zone1/custom_hostnames", {
          hostname: "app.example.com",
          ssl: { method: "http", type: "dv" },
        })
        .reply(200, { success: true, result: { id: "ch1" }, errors: [], messages: [] });

      const action = findAction("create_custom_hostname");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1", hostname: "app.example.com" }, instance);

      expect(result).toEqual({ id: "ch1" });
    });
  });

  describe("delete_custom_hostname", () => {
    it("deletes a custom hostname successfully", async () => {
      nock(BASE_URL)
        .delete("/client/v4/zones/zone1/custom_hostnames/ch1")
        .reply(200, { success: true, result: { id: "ch1" }, errors: [], messages: [] });

      const action = findAction("delete_custom_hostname");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1", customHostnameId: "ch1" }, instance);

      expect(result).toEqual({ id: "ch1" });
    });
  });

  describe("list_zone_analytics", () => {
    it("returns analytics dashboard data on success", async () => {
      const analytics = { totals: { requests: { all: 100 } } };
      nock(BASE_URL)
        .get("/client/v4/zones/zone1/analytics/dashboard")
        .query({ since: "2026-09-01", until: "2026-09-13" })
        .reply(200, { success: true, result: analytics, errors: [], messages: [] });

      const action = findAction("list_zone_analytics");
      const instance = makeInstance({ apiToken: "tok_123" });
      const result = await action.handler({ zoneId: "zone1", since: "2026-09-01", until: "2026-09-13" }, instance);

      expect(result).toEqual(analytics);
    });
  });
});
