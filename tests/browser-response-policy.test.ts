import assert from "node:assert/strict";
import test from "node:test";
import {isExpectedRetainedMediaMiss} from "../src/browser.js";

const baseUrl = "https://oscar.local";

test("accepts only an exact same-origin retained-media GET 404", () => {
  assert.equal(isExpectedRetainedMediaMiss(
    baseUrl,
    "GET",
    404,
    "https://oscar.local/sensorhub/buckets/videos/media/0jss260",
  ), true);
  assert.equal(isExpectedRetainedMediaMiss(
    baseUrl,
    "GET",
    404,
    "https://oscar.local/sensorhub/buckets/videos/media/node-0.15303634153679013",
  ), true);
});

test("does not suppress failures outside the retained-media fallback contract", () => {
  const exactUrl = "https://oscar.local/sensorhub/buckets/videos/media/0jss260";
  assert.equal(isExpectedRetainedMediaMiss(baseUrl, "POST", 404, exactUrl), false);
  assert.equal(isExpectedRetainedMediaMiss(baseUrl, "GET", 500, exactUrl), false);
  assert.equal(isExpectedRetainedMediaMiss(baseUrl, "GET", 404, `${exactUrl}?probe=true`), false);
  assert.equal(isExpectedRetainedMediaMiss(baseUrl, "GET", 404, `${exactUrl}/frame-0.jpg`), false);
  assert.equal(isExpectedRetainedMediaMiss(baseUrl, "GET", 404,
    "https://other.test/sensorhub/buckets/videos/media/0jss260"), false);
  assert.equal(isExpectedRetainedMediaMiss(baseUrl, "GET", 404,
    "https://oscar.local/sensorhub/buckets/videos/media/%2e%2e%2fadmin"), false);
  assert.equal(isExpectedRetainedMediaMiss(baseUrl, "GET", 404,
    "https://oscar.local/sensorhub/buckets/videos/media/"), false);
});
