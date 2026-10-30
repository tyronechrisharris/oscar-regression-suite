import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVANCED_DATE_FILTER_PAGE_SIZE,
  assessAdvancedDateFilterResponses,
  buildAdvancedDateFilterProbeUrls,
  deriveExclusiveDateCutoff,
  hasDashboardAlarmPredicate,
  isEventObservationPageUrl,
} from "../src/event-filter-oracle.js";

const origin = "https://oscar.test";
const baseSource = origin + "/sensorhub/api/observations?" + new URLSearchParams({
  resultTime: "../2026-10-24T15:30:00.000Z",
  format: "application/om+json",
  dataStream: "0gfg,0ggg",
  order: "desc",
  offset: "0",
  limit: String(ADVANCED_DATE_FILTER_PAGE_SIZE),
}).toString();

const page = (startTimes: string[]) => ({
  items: startTimes.map((startTime, index) => ({
    id: `event-${index}`,
    result: {startTime},
  })),
});

test("advanced date-filter oracle derives an exclusive cutoff from a known nonempty occupancy page", () => {
  assert.equal(deriveExclusiveDateCutoff(page([
    "2026-10-23T15:09:36.226Z",
    "2026-10-23T15:09:37.100Z",
  ])), "2026-10-23T15:09:37.101Z");
  assert.throws(() => deriveExclusiveDateCutoff({items: []}), /nonempty items array/);
  assert.throws(() => deriveExclusiveDateCutoff(page(["not-a-date"])), /valid timestamp/);
});

test("advanced date-filter URLs preserve the source fence and streams for count and page", () => {
  assert.equal(isEventObservationPageUrl(baseSource, origin), true);
  const probe = buildAdvancedDateFilterProbeUrls(
    baseSource,
    origin,
    "2026-10-23T15:10:00.000Z",
  );
  const count = new URL(probe.countUrl);
  const resultPage = new URL(probe.pageUrl);
  assert.equal(count.pathname, "/sensorhub/api/observations/count");
  assert.equal(count.searchParams.get("dataStream"), "0gfg,0ggg");
  assert.equal(count.searchParams.get("resultTime"), "../2026-10-24T15:30:00.000Z");
  assert.equal(count.searchParams.has("limit"), false);
  assert.equal(count.searchParams.get("filter"), "startTime<'2026-10-23T15:10:00.000Z'");
  assert.equal(resultPage.searchParams.get("limit"), "15");
  assert.equal(resultPage.searchParams.get("offset"), "0");
  assert.equal(resultPage.searchParams.get("order"), "desc");
  assert.equal(probe.datastreamCount, 2);
});

test("Dashboard probe retains the unadjudicated alarm predicate when adding the date filter", () => {
  const source = new URL(baseSource);
  source.searchParams.set(
    "filter",
    "((gammaAlarm=true OR neutronAlarm=true) AND adjudicatedIdsCount=0) AND (gammaAlarm=true AND neutronAlarm=false)",
  );
  assert.equal(hasDashboardAlarmPredicate(source.toString()), true);
  const probe = buildAdvancedDateFilterProbeUrls(
    source.toString(),
    origin,
    "2026-10-23T15:10:00.000Z",
  );
  const filter = new URL(probe.pageUrl).searchParams.get("filter") ?? "";
  assert.match(filter, /gammaAlarm=true OR neutronAlarm=true/);
  assert.match(filter, /adjudicatedIdsCount=0/);
  assert.match(filter, /startTime<'2026-10-23T15:10:00.000Z'/);

  const eventLogBucket = new URL(baseSource);
  eventLogBucket.searchParams.set("filter", "gammaAlarm=false AND neutronAlarm=false");
  assert.equal(hasDashboardAlarmPredicate(eventLogBucket.toString()), false);
  assert.equal(isEventObservationPageUrl(eventLogBucket.toString(), origin), true);
});

test("advanced date-filter response requires two successes, a positive count, and rows before cutoff", () => {
  const cutoff = "2026-10-23T15:10:00.000Z";
  const valid = assessAdvancedDateFilterResponses(
    200,
    {count: 50},
    200,
    page(["2026-10-23T15:09:36.226Z", "2026-10-23T14:01:17.669Z"]),
    cutoff,
  );
  assert.deepEqual(valid, {
    passed: true,
    count: 50,
    pageItems: 2,
    validStartTimes: 2,
    beforeCutoff: 2,
    reason: "",
  });

  assert.equal(assessAdvancedDateFilterResponses(500, null, 500, null, cutoff).passed, false);
  assert.equal(assessAdvancedDateFilterResponses(200, {count: 0}, 200, page([
    "2026-10-23T15:09:36.226Z",
  ]), cutoff).passed, false);
  const boundaryFailure = assessAdvancedDateFilterResponses(
    200,
    {count: 1},
    200,
    page([cutoff]),
    cutoff,
  );
  assert.equal(boundaryFailure.passed, false);
  assert.match(boundaryFailure.reason, /did not precede/);
});

test("advanced date-filter source validation rejects foreign and malformed queries", () => {
  assert.equal(isEventObservationPageUrl(baseSource, "https://other.test"), false);
  const missingStreams = new URL(baseSource);
  missingStreams.searchParams.delete("dataStream");
  assert.equal(isEventObservationPageUrl(missingStreams.toString(), origin), false);
  assert.throws(() => buildAdvancedDateFilterProbeUrls(
    baseSource.replace(origin, "https://other.test"),
    origin,
    "2026-10-23T15:10:00.000Z",
  ), /origin does not match/);
});
