import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import porkbunService from "../src/services/porkbun.js";
import type { InstanceConfig } from "../src/core/types.js";

const BASE_URL = "https://api.porkbun.com/api/json/v3";

function makeInstance(fields: Record<string, string> = { apiKey: "pk_test", secretApiKey: "sk_test" }): InstanceConfig {
  return { id: "default", fields };
}

function findAction(id: string) {
  const action = porkbunService.buildActions().find((a) => a.id === id);
  if (!action) throw new Error(`action ${id} not found`);
  return action;
}

describe("porkbun service", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("parseInstanceFields", () => {
    it("throws when apiKey is missing", () => {
      expect(() => porkbunService.parseInstanceFields({ secretApiKey: "sk_test" })).toThrow(/apiKey/);
    });

    it("throws when secretApiKey is missing", () => {
      expect(() => porkbunService.parseInstanceFields({ apiKey: "pk_test" })).toThrow(/secretApiKey/);
    });

    it("succeeds and returns fields when both are present", () => {
      const fields = { apiKey: "pk_test", secretApiKey: "sk_test" };
      expect(porkbunService.parseInstanceFields(fields)).toEqual(fields);
    });
  });

  describe("list_domains", () => {
    it("returns parsed domains on success", async () => {
      const scope = nock(BASE_URL)
        .post("/domain/listAll", {
          apikey: "pk_test",
          secretapikey: "sk_test",
          start: 0,
          includeLabels: "yes",
        })
        .reply(200, {
          status: "SUCCESS",
          domains: [{ domain: "example.com", status: "ACTIVE" }],
        });

      const action = findAction("list_domains");
      const result = (await action.handler({ start: 0, includeLabels: "yes" }, makeInstance())) as {
        domains: Array<{ domain: string }>;
      };

      expect(result.domains).toHaveLength(1);
      expect(result.domains[0]!.domain).toBe("example.com");
      expect(scope.isDone()).toBe(true);
    });

    it("throws the Porkbun error message on ERROR status", async () => {
      nock(BASE_URL).post("/domain/listAll").reply(200, {
        status: "ERROR",
        message: "Invalid API key.",
      });

      const action = findAction("list_domains");
      await expect(action.handler({}, makeInstance())).rejects.toThrow("Invalid API key.");
    });
  });

  describe("delete_dns_record", () => {
    it("deletes the record and returns success", async () => {
      const scope = nock(BASE_URL)
        .post("/dns/delete/example.com/12345", {
          apikey: "pk_test",
          secretapikey: "sk_test",
        })
        .reply(200, { status: "SUCCESS" });

      const action = findAction("delete_dns_record");
      const result = (await action.handler({ domain: "example.com", recordId: "12345" }, makeInstance())) as {
        status: string;
      };

      expect(result.status).toBe("SUCCESS");
      expect(scope.isDone()).toBe(true);
    });
  });
});
