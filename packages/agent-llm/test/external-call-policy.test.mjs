import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  DEFAULT_PROVIDER_RETRY_BACKOFF_FACTOR,
  DEFAULT_PROVIDER_RETRY_DELAY_SECONDS,
  DEFAULT_PROVIDER_TIMEOUT_SECONDS,
  providerCallPolicy,
} from "../dist/index.js";

test("provider call policy uses the shared resilient defaults", () => {
  assert.deepEqual(providerCallPolicy({}), {
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_SECONDS * 1000,
    maxAttempts: DEFAULT_PROVIDER_RETRY_ATTEMPTS + 1,
    baseDelayMs: DEFAULT_PROVIDER_RETRY_DELAY_SECONDS * 1000,
    backoffFactor: DEFAULT_PROVIDER_RETRY_BACKOFF_FACTOR,
  });
});

test("provider call policy preserves explicit overrides, including disabling retries and delay", () => {
  assert.deepEqual(providerCallPolicy({
    timeout: 45,
    retry_attempts: 0,
    retry_delay: 0,
    retry_backoff_factor: 3,
  }), {
    timeoutMs: 45_000,
    maxAttempts: 1,
    baseDelayMs: 0,
    backoffFactor: 3,
  });
});
