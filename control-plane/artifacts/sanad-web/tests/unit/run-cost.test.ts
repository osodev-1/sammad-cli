import { describe, it, expect } from "vitest";
import { costUsdMicros } from "@/lib/runs/store";

describe("costUsdMicros", () => {
  it("prices kimi-k3 tokens", () => {
    // 1M in @ $0.60 + 1M out @ $2.50 = $3.10 = 3_100_000 micros
    expect(costUsdMicros("kimi-k3", 1_000_000, 1_000_000)).toBe(3_100_000);
  });
  it("unknown alias costs zero, never throws", () => {
    expect(costUsdMicros("nope", 5_000, 5_000)).toBe(0);
    expect(costUsdMicros(null, 5_000, 5_000)).toBe(0);
  });
  it("rounds to integer micros", () => {
    expect(Number.isInteger(costUsdMicros("kimi-k3", 123, 457))).toBe(true);
  });
});
