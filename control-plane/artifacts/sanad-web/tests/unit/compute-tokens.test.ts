import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  deriveMachineToken,
  machineTokenMatches,
  workspaceHash,
  deriveTrustStoreKey,
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

describe("deriveTrustStoreKey", () => {
  it("is stable for the same user", () => {
    const k = deriveTrustStoreKey("user_1");
    expect(k).toBe(deriveTrustStoreKey("user_1"));
  });

  it("differs across users", () => {
    expect(deriveTrustStoreKey("user_1")).not.toBe(deriveTrustStoreKey("user_2"));
  });

  it("differs from deriveMachineToken for the same user", () => {
    const trustKey = deriveTrustStoreKey("user_1");
    const machineToken = deriveMachineToken("user_1", "nonce-1");
    expect(trustKey).not.toBe(machineToken);
  });

  it("changes when TERMINAL_MACHINE_KEY changes", () => {
    const k1 = deriveTrustStoreKey("user_1");
    process.env.TERMINAL_MACHINE_KEY = "different-machine-key";
    const k2 = deriveTrustStoreKey("user_1");
    expect(k1).not.toBe(k2);
  });

  it("throws without the key (fail closed)", () => {
    delete process.env.TERMINAL_MACHINE_KEY;
    expect(() => deriveTrustStoreKey("user_1")).toThrow(/TERMINAL_MACHINE_KEY/);
  });
});
