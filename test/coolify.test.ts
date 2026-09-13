import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import coolifyService from "../src/services/coolify.js";
import type { InstanceConfig } from "../src/core/types.js";

const BASE_URL = "https://coolify.example.com";

function findAction(id: string) {
  const action = coolifyService.buildActions().find((a) => a.id === id);
  if (!action) throw new Error(`action ${id} not found`);
  return action;
}

function makeInstance(fields: Record<string, string>): InstanceConfig {
  return { id: "default", fields };
}

describe("coolify service", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe("parseInstanceFields", () => {
    it("throws when baseUrl is missing", () => {
      expect(() => coolifyService.parseInstanceFields({ apiToken: "tok" })).toThrow(/baseUrl|BASE_URL/i);
    });

    it("throws when apiToken is missing", () => {
      expect(() => coolifyService.parseInstanceFields({ baseUrl: BASE_URL })).toThrow(/apiToken|API_TOKEN/i);
    });

    it("succeeds with valid fields and defaults insecureTls to false", () => {
      const result = coolifyService.parseInstanceFields({ baseUrl: BASE_URL, apiToken: "tok_123" });
      expect(result.baseUrl).toBe(BASE_URL);
      expect(result.apiToken).toBe("tok_123");
      expect(result.insecureTls).toBe("false");
    });
  });

  describe("list_applications", () => {
    it("sends the bearer token and returns the list", async () => {
      const scope = nock(BASE_URL, {
        reqheaders: { authorization: "Bearer tok_123" },
      })
        .get("/api/v1/applications")
        .reply(200, [{ uuid: "app-1", name: "web" }]);

      const action = findAction("list_applications");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });
      const result = await action.handler({}, instance);

      expect(scope.isDone()).toBe(true);
      expect(result).toEqual([{ uuid: "app-1", name: "web" }]);
    });
  });

  describe("start_application", () => {
    it("posts to the start endpoint", async () => {
      const scope = nock(BASE_URL).post("/api/v1/applications/app-1/start").reply(200, { message: "started" });

      const action = findAction("start_application");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });
      const result = await action.handler({ uuid: "app-1" }, instance);

      expect(scope.isDone()).toBe(true);
      expect(result).toEqual({ message: "started" });
    });
  });

  describe("deploy", () => {
    it("requires either uuid or tag", async () => {
      const action = findAction("deploy");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });

      await expect(action.handler({}, instance)).rejects.toThrow(/requires either uuid or tag/);
    });

    it("posts to /deploy with the uuid and force query params", async () => {
      const scope = nock(BASE_URL)
        .post("/api/v1/deploy")
        .query({ uuid: "app-1", force: "true" })
        .reply(200, [{ message: "queued", resource_uuid: "app-1", deployment_uuid: "dep-1" }]);

      const action = findAction("deploy");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });
      const result = await action.handler({ uuid: "app-1", force: true }, instance);

      expect(scope.isDone()).toBe(true);
      expect(result).toEqual([{ message: "queued", resource_uuid: "app-1", deployment_uuid: "dep-1" }]);
    });
  });

  describe("create_application_env", () => {
    it("posts the mapped env body", async () => {
      const scope = nock(BASE_URL)
        .post("/api/v1/applications/app-1/envs", {
          key: "FOO",
          value: "bar",
          is_preview: false,
          is_build_time: false,
          is_literal: false,
        })
        .reply(201, { uuid: "env-1" });

      const action = findAction("create_application_env");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });
      const result = await action.handler({ uuid: "app-1", key: "FOO", value: "bar" }, instance);

      expect(scope.isDone()).toBe(true);
      expect(result).toEqual({ uuid: "env-1" });
    });
  });

  describe("error handling", () => {
    it("surfaces the .message from a non-2xx response", async () => {
      nock(BASE_URL).get("/api/v1/applications/missing").reply(404, { message: "Application not found." });

      const action = findAction("get_application");
      const instance = makeInstance({ baseUrl: BASE_URL, apiToken: "tok_123" });

      await expect(action.handler({ uuid: "missing" }, instance)).rejects.toThrow(/Application not found\./);
    });
  });
});
