import { describe, expect, test } from "bun:test";
import { testConfig } from "./helpers.js";

describe("Graceful Shutdown Configuration", () => {
  test("accepts default shutdown timeout of 10000ms", () => {
    const config = testConfig();
    expect(config.shutdownTimeoutMs).toBe(10000);
  });

  test("accepts custom valid shutdown timeouts", () => {
    expect(testConfig({ SHUTDOWN_TIMEOUT_MS: "5000" }).shutdownTimeoutMs).toBe(
      5000,
    );
    expect(testConfig({ SHUTDOWN_TIMEOUT_MS: "1" }).shutdownTimeoutMs).toBe(1);
    expect(testConfig({ SHUTDOWN_TIMEOUT_MS: "60000" }).shutdownTimeoutMs).toBe(
      60000,
    );
  });

  test("rejects invalid shutdown timeouts", () => {
    expect(() => testConfig({ SHUTDOWN_TIMEOUT_MS: "0" })).toThrow(
      /SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 60000/,
    );
    expect(() => testConfig({ SHUTDOWN_TIMEOUT_MS: "-100" })).toThrow(
      /SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 60000/,
    );
    expect(() => testConfig({ SHUTDOWN_TIMEOUT_MS: "60001" })).toThrow(
      /SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 60000/,
    );
    expect(() => testConfig({ SHUTDOWN_TIMEOUT_MS: "invalid" })).toThrow(
      /SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 60000/,
    );
  });
});
