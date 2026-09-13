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

  describe("get_url_forwarding", () => {
    it("returns the list of url forwards on success", async () => {
      const scope = nock(BASE_URL)
        .post("/domain/getUrlForwarding/example.com", {
          apikey: "pk_test",
          secretapikey: "sk_test",
        })
        .reply(200, {
          status: "SUCCESS",
          forwards: [{ id: "1", subdomain: "", location: "https://example.org", type: "temporary" }],
        });

      const action = findAction("get_url_forwarding");
      const result = (await action.handler({ domain: "example.com" }, makeInstance())) as {
        forwards: Array<{ location: string }>;
      };

      expect(result.forwards).toHaveLength(1);
      expect(result.forwards[0]!.location).toBe("https://example.org");
      expect(scope.isDone()).toBe(true);
    });

    it("throws the Porkbun error message on ERROR status", async () => {
      nock(BASE_URL).post("/domain/getUrlForwarding/example.com").reply(200, {
        status: "ERROR",
        message: "Invalid domain.",
      });

      const action = findAction("get_url_forwarding");
      await expect(action.handler({ domain: "example.com" }, makeInstance())).rejects.toThrow("Invalid domain.");
    });
  });

  describe("add_url_forwarding", () => {
    it("adds a url forward with defaults applied", async () => {
      const scope = nock(BASE_URL)
        .post("/domain/addUrlForward/example.com", {
          apikey: "pk_test",
          secretapikey: "sk_test",
          location: "https://example.org",
          type: "temporary",
          includePath: "no",
          wildcard: "no",
        })
        .reply(200, { status: "SUCCESS" });

      const action = findAction("add_url_forwarding");
      const result = (await action.handler(
        { domain: "example.com", location: "https://example.org" },
        makeInstance()
      )) as { status: string };

      expect(result.status).toBe("SUCCESS");
      expect(scope.isDone()).toBe(true);
    });
  });

  describe("delete_url_forwarding", () => {
    it("deletes the url forward and returns success", async () => {
      const scope = nock(BASE_URL)
        .post("/domain/deleteUrlForward/example.com/99", {
          apikey: "pk_test",
          secretapikey: "sk_test",
        })
        .reply(200, { status: "SUCCESS" });

      const action = findAction("delete_url_forwarding");
      const result = (await action.handler(
        { domain: "example.com", recordId: "99" },
        makeInstance()
      )) as { status: string };

      expect(result.status).toBe("SUCCESS");
      expect(scope.isDone()).toBe(true);
    });
  });

  describe("get_nameservers", () => {
    it("returns the current nameservers on success", async () => {
      const scope = nock(BASE_URL)
        .post("/domain/getNs/example.com", {
          apikey: "pk_test",
          secretapikey: "sk_test",
        })
        .reply(200, { status: "SUCCESS", ns: ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"] });

      const action = findAction("get_nameservers");
      const result = (await action.handler({ domain: "example.com" }, makeInstance())) as { ns: string[] };

      expect(result.ns).toEqual(["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"]);
      expect(scope.isDone()).toBe(true);
    });
  });

  describe("check_domain_pricing", () => {
    it("returns the default TLD pricing list on success", async () => {
      const scope = nock(BASE_URL)
        .post("/pricing/get", {
          apikey: "pk_test",
          secretapikey: "sk_test",
        })
        .reply(200, { status: "SUCCESS", pricing: { com: { registration: "9.68", renewal: "9.68" } } });

      const action = findAction("check_domain_pricing");
      const result = (await action.handler({}, makeInstance())) as {
        pricing: Record<string, { registration: string }>;
      };

      expect(result.pricing.com!.registration).toBe("9.68");
      expect(scope.isDone()).toBe(true);
    });
  });
});
