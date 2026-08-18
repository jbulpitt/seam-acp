import { describe, it, expect } from "vitest";
import { parseGrokBilling } from "../src/agents/profiles/grok.js";

const PROBE = {
  config: {
    creditUsagePercent: 21,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-15T18:27:12.762972+00:00",
      end: "2026-08-22T18:27:12.762972+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodStart: "2026-08-15T18:27:12.762972+00:00",
    billingPeriodEnd: "2026-08-22T18:27:12.762972+00:00",
  },
  subscription_tier: "SuperGrok Heavy",
};

describe("parseGrokBilling", () => {
  it("reads the SuperGrok Heavy weekly allowance from a live _x.ai/billing payload", () => {
    const d = parseGrokBilling(PROBE);
    expect(d.subscriptionTier).toBe("SuperGrok Heavy");
    expect(d.creditUsagePercent).toBe(21);
    expect(d.periodType).toBe("weekly");
    expect(d.periodStart).toBe("2026-08-15T18:27:12.762972+00:00");
    expect(d.periodEnd).toBe("2026-08-22T18:27:12.762972+00:00");
    expect(d.isUnifiedBillingUser).toBe(true);
  });

  it("falls back to billingPeriod* when currentPeriod is missing", () => {
    const d = parseGrokBilling({
      config: {
        creditUsagePercent: 5,
        billingPeriodStart: "2026-01-01T00:00:00Z",
        billingPeriodEnd: "2026-01-08T00:00:00Z",
      },
    });
    expect(d.creditUsagePercent).toBe(5);
    expect(d.periodType).toBeNull();
    expect(d.periodStart).toBe("2026-01-01T00:00:00Z");
    expect(d.periodEnd).toBe("2026-01-08T00:00:00Z");
    expect(d.subscriptionTier).toBeNull();
  });

  it("returns empty fields on garbage", () => {
    expect(parseGrokBilling(null).creditUsagePercent).toBeNull();
    expect(parseGrokBilling("nope").subscriptionTier).toBeNull();
    expect(parseGrokBilling({}).periodEnd).toBeNull();
  });
});
