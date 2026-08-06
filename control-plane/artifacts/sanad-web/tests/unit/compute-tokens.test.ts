import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  deriveMachineToken,
  machineTokenMatches,
  workspaceHash,
} from "@/lib/compute/tokens";

const saved = process.env.TERMINAL_MACHINE_KEY;

beforeEach(() => {
  process.env.TERMINAL_MACHINE_KEY = "test-machine-key";
});
afterAll(() => {
  if (saved === undefined) delete process.env.TERMINAL_MACHINE_KEY;
  else process.env.TERMINAL_MACHINE_KEY = saved;
});

describe("machine tokens", () => {
  it("derives deterministically and verifies timing-safe", () => {
    const t = deriveMachineToken("user_1", "nonce-1");
    expect(t).toBe(deriveMachineToken("user_1", "nonce-1"));
    expect(machineTokenMatches(t, "user_1", "nonce-1")).toBe(true);
    expect(machineTokenMatches(t, "user_2", "nonce-1")).toBe(false);
    expect(machineTokenMatches(t, "user_1", "nonce-2")).toBe(false);
    expect(machineTokenMatches("garbage", "user_1", "nonce-1")).toBe(false);
  });

  it("throws without the key (fail closed)", () => {
    delete process.env.TERMINAL_MACHINE_KEY;
    expect(() => deriveMachineToken("user_1", "n")).toThrow(/TERMINAL_MACHINE_KEY/);
  });

  it("workspaceHash is 12 lowercase hex chars, stable, PII-free", () => {
    const h = workspaceHash("user_3HQRsEYTgQR9oSP70p1ZMSmfTez");
    expect(h).toMatch(/^[a-f0-9]{12}$/);
    expect(h).toBe(workspaceHash("user_3HQRsEYTgQR9oSP70p1ZMSmfTez"));
    expect(h).not.toContain("user");
    expect(workspaceHash("user_other")).not.toBe(h);
  });
});
