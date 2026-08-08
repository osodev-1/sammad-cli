import { describe, expect, it } from "vitest";
import { fillDailySeries } from "@/lib/billing/usage-series";

const NOW = Date.parse("2026-08-08T15:00:00Z");

describe("fillDailySeries", () => {
  it("fills gaps to N continuous UTC days ending today", () => {
    const s = fillDailySeries(
      [{ day: "2026-08-08", requests: 3, tokensIn: 10, tokensOut: 5 }],
      3,
      NOW,
    );
    expect(s.map((d) => d.day)).toEqual([
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ]);
    expect(s[2]).toEqual({
      day: "2026-08-08",
      requests: 3,
      tokensIn: 10,
      tokensOut: 5,
    });
    expect(s[0]).toEqual({
      day: "2026-08-06",
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  it("drops rows outside the window and zero-fills the rest", () => {
    const s = fillDailySeries(
      [
        { day: "2026-08-07", requests: 1, tokensIn: 1, tokensOut: 1 },
        { day: "2020-01-01", requests: 9, tokensIn: 9, tokensOut: 9 },
      ],
      2,
      NOW,
    );
    expect(s.map((d) => d.day)).toEqual(["2026-08-07", "2026-08-08"]);
    expect(s[0].requests).toBe(1);
    expect(s[1].requests).toBe(0);
  });
});
