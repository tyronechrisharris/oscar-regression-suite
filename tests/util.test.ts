import assert from "node:assert/strict";
import test from "node:test";
import {normalizePathname} from "../src/util.js";

test("normalizePathname accepts canonical routes with or without trailing slashes", () => {
  assert.equal(normalizePathname("/event-details"), "/event-details");
  assert.equal(normalizePathname("/event-details/"), "/event-details");
  assert.equal(normalizePathname("/event-details///"), "/event-details");
  assert.equal(normalizePathname("/"), "/");
});
