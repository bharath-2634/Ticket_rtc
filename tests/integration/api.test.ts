import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../apps/api/src/app.js";

describe("API liveness", () => {
  it("returns an OK status", async () => {
    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});