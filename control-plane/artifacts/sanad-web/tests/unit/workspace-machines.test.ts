import { describe, it, expect } from "vitest";
import { machineHash } from "@/lib/compute/machines";
import { sessionHash } from "@/lib/compute/tokens";

describe("machineHash", () => {
  it("is 12 hex chars and stable", () => {
    const h = machineHash("ws_1", "prod");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(machineHash("ws_1", "prod")).toBe(h);
  });
  it("differs per env and never collides with user-session hashing", () => {
    expect(machineHash("ws_1", "dev")).not.toBe(machineHash("ws_1", "prod"));
    expect(machineHash("u1", "s1")).not.toBe(sessionHash("u1", "s1"));
  });
});
