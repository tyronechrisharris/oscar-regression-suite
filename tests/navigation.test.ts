import assert from "node:assert/strict";
import test from "node:test";
import {
  isTooManyRetriesNavigationError,
  navigateWithBoundedRetry,
} from "../src/navigation.js";

test("recognizes only the exact Chromium too-many-retries network token", () => {
  assert.equal(isTooManyRetriesNavigationError(
    new Error("page.goto: net::ERR_TOO_MANY_RETRIES at https://oscar.test/"),
  ), true);
  assert.equal(isTooManyRetriesNavigationError(new Error("ERR_TOO_MANY_RETRIES")), false);
  assert.equal(isTooManyRetriesNavigationError(new Error("net::ERR_TOO_MANY_RETRIES_OTHER")), false);
  assert.equal(isTooManyRetriesNavigationError(new Error("net::ERR_CONNECTION_RESET")), false);
});

test("returns a successful first navigation without probing or waiting", async () => {
  let probes = 0;
  let warnings = 0;
  let waits = 0;
  const status = await navigateWithBoundedRetry({
    navigate: async () => 200,
    verifyTarget: async () => { probes++; },
    onFirstFailure: () => { warnings++; },
    wait: async () => { waits++; },
  });

  assert.equal(status, 200);
  assert.equal(probes, 0);
  assert.equal(warnings, 0);
  assert.equal(waits, 0);
});

test("probes, waits one second, and retries one matching transient once", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const status = await navigateWithBoundedRetry({
    navigate: async () => {
      attempts++;
      calls.push(`navigate-${attempts}`);
      if (attempts === 1) throw new Error("page.goto: net::ERR_TOO_MANY_RETRIES at https://oscar.test/");
      return 200;
    },
    verifyTarget: async () => { calls.push("probe"); },
    onFirstFailure: () => { calls.push("warning"); },
    wait: async (milliseconds) => { calls.push(`wait-${milliseconds}`); },
  });

  assert.equal(status, 200);
  assert.deepEqual(calls, ["navigate-1", "warning", "probe", "wait-1000", "navigate-2"]);
});

test("does not retry a different navigation failure", async () => {
  const failure = new Error("page.goto: net::ERR_CONNECTION_RESET");
  let attempts = 0;
  await assert.rejects(navigateWithBoundedRetry({
    navigate: async () => { attempts++; throw failure; },
    verifyTarget: async () => assert.fail("probe must not run"),
    onFirstFailure: () => assert.fail("warning must not be recorded"),
    wait: async () => assert.fail("wait must not run"),
  }), (error) => error === failure);
  assert.equal(attempts, 1);
});

test("a failed target probe prevents the retry", async () => {
  const probeFailure = new Error("session probe returned HTTP 401");
  let attempts = 0;
  await assert.rejects(navigateWithBoundedRetry({
    navigate: async () => {
      attempts++;
      throw new Error("page.goto: net::ERR_TOO_MANY_RETRIES");
    },
    verifyTarget: async () => { throw probeFailure; },
    onFirstFailure: () => undefined,
    wait: async () => assert.fail("wait must not run after a failed probe"),
  }), (error) => error === probeFailure);
  assert.equal(attempts, 1);
});

test("a repeated too-many-retries failure remains fatal after two attempts", async () => {
  let attempts = 0;
  await assert.rejects(navigateWithBoundedRetry({
    navigate: async () => {
      attempts++;
      throw new Error(`attempt ${attempts}: net::ERR_TOO_MANY_RETRIES`);
    },
    verifyTarget: async () => undefined,
    onFirstFailure: () => undefined,
    wait: async () => undefined,
  }), /attempt 2: net::ERR_TOO_MANY_RETRIES/);
  assert.equal(attempts, 2);
});
