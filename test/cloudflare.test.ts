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
});
