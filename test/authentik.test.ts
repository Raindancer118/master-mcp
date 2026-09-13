import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import authentikService from "../src/services/authentik.js";
import type { InstanceConfig } from "../src/core/types.js";

const BASE_URL = "https://auth.example.com";

function findAction(id: string) {
  const action = authentikService.buildActions().find((a) => a.id === id);
  if (!action) throw new Error(`action ${id} not found`);
  return action;
}

function makeInstance(fields: Record<string, string>): InstanceConfig {
  return { id: "default", fields };
}

describe("authentik service", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("parseInstanceFields", () => {
    it("throws when baseUrl is missing", () => {
      expect(() => authentikService.parseInstanceFields({ apiToken: "tok" })).toThrow(/baseUrl|BASE_URL/i);
    });

    it("throws when apiToken is missing", () => {
      expect(() => authentikService.parseInstanceFields({ baseUrl: BASE_URL })).toThrow(/apiToken|API_TOKEN/i);
    });

    it("succeeds with valid fields and defaults insecureTls to false", () => {
      const result = authentikService.parseInstanceFields({ baseUrl: BASE_URL, apiToken: "tok_123" });
      expect(result.baseUrl).toBe(BASE_URL);
      expect(result.apiToken).toBe("tok_123");
      expect(result.insecureTls).toBe("false");
    });
  });

  describe("list_users", () => {
    it("sends the bearer token and maps query params", async () => {
      const scope = nock(BASE_URL, {
        reqheaders: { authorization: "Bearer tok_123" },
      })
        .get("/api/v3/core/users/")
        .query({ search: "tom", is_active: "true" })
        .reply(200, { pagination: { count: 1 }, results: [{ pk: 1, username: "tom" }] });

      const action = findAction("list_users");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });
      const result = await action.handler({ search: "tom", isActive: true }, instance);

      expect(scope.isDone()).toBe(true);
      expect(result).toEqual({ pagination: { count: 1 }, results: [{ pk: 1, username: "tom" }] });
    });
  });

  describe("create_user", () => {
    it("posts the mapped body and returns the created user", async () => {
      const scope = nock(BASE_URL)
        .post("/api/v3/core/users/", {
          username: "tom",
          name: "Tom",
          email: "tom@example.com",
          is_active: true,
          groups: [1],
        })
        .reply(201, { pk: 42, username: "tom" });

      const action = findAction("create_user");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });
      const result = await action.handler(
        { username: "tom", name: "Tom", email: "tom@example.com", groups: [1] },
        instance
      );

      expect(scope.isDone()).toBe(true);
      expect(result).toEqual({ pk: 42, username: "tom" });
    });
  });

  describe("add_user_to_group", () => {
    it("posts pk to the group's add_user endpoint", async () => {
      const scope = nock(BASE_URL)
        .post("/api/v3/core/groups/abc-123/add_user/", { pk: 42 })
        .reply(204);

      const action = findAction("add_user_to_group");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });
      await action.handler({ groupId: "abc-123", userId: 42 }, instance);

      expect(scope.isDone()).toBe(true);
    });
  });

  describe("error handling", () => {
    it("surfaces the .detail message from a non-2xx response", async () => {
      nock(BASE_URL)
        .get("/api/v3/core/users/1/")
        .reply(404, { detail: "Not found." });

      const action = findAction("get_user");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });

      await expect(action.handler({ userId: 1 }, instance)).rejects.toThrow(/Not found\./);
    });
  });
});
