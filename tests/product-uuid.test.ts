import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalProductUuid,
  isCanonicalProductUuid,
} from "../src/product-uuid.js";

test("product UUID accepts canonical RFC 4122 versions and variants", () => {
  for (const value of [
    "123e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-22d3-8456-426614174000",
    "123e4567-e89b-32d3-9456-426614174000",
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-52d3-b456-426614174000",
  ]) assert.equal(isCanonicalProductUuid(value), true);
});

test("product UUID rejects shape-only, uppercase, nil, unsupported version, and variant", () => {
  for (const value of [
    "123e4567-e89b-42d3-7456-426614174000",
    "123e4567-e89b-62d3-a456-426614174000",
    "123E4567-E89B-42D3-A456-426614174000",
    "00000000-0000-0000-0000-000000000000",
    "123e4567-e89b-42d3-a456-42661417400z",
    "123e4567e89b42d3a456426614174000",
  ]) assert.equal(isCanonicalProductUuid(value), false, value);
  assert.throws(() => canonicalProductUuid("event-1", "event UUID"), /canonical lowercase/);
});
