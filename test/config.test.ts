import { describe, expect, it } from "vitest";
import { readSpendPolicyFromEnv } from "../src/config.js";

describe("readSpendPolicyFromEnv", () => {
  it("defaults to conservative no-extra-spend policy", () => {
    const policy = readSpendPolicyFromEnv({});

    expect(policy.allowOverage).toBe(false);
    expect(policy.maxHourlyOverageUsd).toBe(0);
    expect(policy.maxWindowOverageUsd).toBe(0);
    expect(policy.preserveCapabilityAbove.opusToSonnetUsdPerHour).toBe(0);
    expect(policy.preserveCapabilityAbove.sonnetToHaikuUsdPerHour).toBe(0);
  });

  it("parses explicit thresholds from env", () => {
    const policy = readSpendPolicyFromEnv({
      CCBUDGET_ALLOW_OVERAGE: "1",
      CCBUDGET_MAX_HOURLY_OVERAGE_USD: "4.5",
      CCBUDGET_MAX_WINDOW_OVERAGE_USD: "11",
      CCBUDGET_OPUS_TO_SONNET_USD_PER_HOUR: "3",
      CCBUDGET_SONNET_TO_HAIKU_USD_PER_HOUR: "1.25",
    });

    expect(policy.allowOverage).toBe(true);
    expect(policy.maxHourlyOverageUsd).toBe(4.5);
    expect(policy.maxWindowOverageUsd).toBe(11);
    expect(policy.preserveCapabilityAbove.opusToSonnetUsdPerHour).toBe(3);
    expect(policy.preserveCapabilityAbove.sonnetToHaikuUsdPerHour).toBe(1.25);
  });

  it("clamps negative numeric thresholds to zero", () => {
    const policy = readSpendPolicyFromEnv({
      CCBUDGET_MAX_HOURLY_OVERAGE_USD: "-4.5",
      CCBUDGET_MAX_WINDOW_OVERAGE_USD: "-11",
      CCBUDGET_OPUS_TO_SONNET_USD_PER_HOUR: "-3",
      CCBUDGET_SONNET_TO_HAIKU_USD_PER_HOUR: "-1.25",
    });

    expect(policy.maxHourlyOverageUsd).toBe(0);
    expect(policy.maxWindowOverageUsd).toBe(0);
    expect(policy.preserveCapabilityAbove.opusToSonnetUsdPerHour).toBe(0);
    expect(policy.preserveCapabilityAbove.sonnetToHaikuUsdPerHour).toBe(0);
  });

  it("falls back for invalid numerics and non-enabled boolean values", () => {
    const policy = readSpendPolicyFromEnv({
      CCBUDGET_ALLOW_OVERAGE: "yes",
      CCBUDGET_MAX_HOURLY_OVERAGE_USD: "abc",
      CCBUDGET_MAX_WINDOW_OVERAGE_USD: "",
      CCBUDGET_OPUS_TO_SONNET_USD_PER_HOUR: "NaN",
      CCBUDGET_SONNET_TO_HAIKU_USD_PER_HOUR: undefined,
    });

    expect(policy.allowOverage).toBe(false);
    expect(policy.maxHourlyOverageUsd).toBe(0);
    expect(policy.maxWindowOverageUsd).toBe(0);
    expect(policy.preserveCapabilityAbove.opusToSonnetUsdPerHour).toBe(0);
    expect(policy.preserveCapabilityAbove.sonnetToHaikuUsdPerHour).toBe(0);
  });
});
