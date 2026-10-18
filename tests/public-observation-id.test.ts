import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicObservationId,
  publicObservationId,
} from "../src/public-observation-id.js";

test("public observation IDs accept OSCAR encoded IDs and RFC 4122-shaped IDs", () => {
  for (const value of [
    "0i4d0ko",
    "obs/id",
    "123e4567-e89b-42d3-a456-426614174000",
    "X".repeat(128),
  ]) {
    assert.equal(isPublicObservationId(value), true, value);
    assert.equal(publicObservationId(value, "event identity"), value);
  }
});

test("public observation IDs reject nontext, blank, unnormalized, and overlong values", () => {
  for (const value of [undefined, null, 42, "", "   ", " event-1", "event-1 ", "X".repeat(129)]) {
    assert.equal(isPublicObservationId(value), false, String(value));
    assert.throws(
      () => publicObservationId(value, "event identity"),
      /normalized OSCAR public observation ID containing 1-128 characters/,
    );
  }
});
