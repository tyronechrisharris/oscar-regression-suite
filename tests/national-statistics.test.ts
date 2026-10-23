import assert from "node:assert/strict";
import test from "node:test";
import {chromium} from "playwright";
import {
  assertNationalRefreshCompletedControl,
  assertFreshNationalStatisticsObservation,
  assertNationalRefreshPendingControl,
  assessExactNationalStatisticsObservation,
  assessLatestNationalStatisticsObservation,
  assessNationalStatisticsCommandStatus,
  assessNationalStatisticsCommandSubmission,
  classifyNationalStatisticsViewerObservationResponse,
  isNationalRefreshCompletedControl,
  NATIONAL_REFRESH_CONTROL_SELECTOR,
  NATIONAL_STATISTICS_COMPLETION_TIMEOUT_MS,
  nationalStatisticsEqual,
  parseRenderedNationalStatistics,
} from "../src/national-statistics.js";

const counts = {
  numGammaAlarms: 1,
  numNeutronAlarms: 2,
  numGammaNeutronAlarms: 3,
  numOccupancies: 4,
  numTampers: 5,
  numGammaFaults: 6,
  numNeutronFaults: 7,
  numFaults: 8,
};

function observation(id: string, resultTime = "2026-10-23T17:00:00Z") {
  return {
    id,
    phenomenonTime: resultTime,
    resultTime,
    result: {allTime: counts},
  };
}

function status(statusCode: string, resultObservationId?: string) {
  return {
    "command@id": "command-1",
    statusCode,
    ...(resultObservationId ? {results: [{"observation@id": resultObservationId}]} : {}),
  };
}

test("national observation oracle captures one exact baseline and validates all counts", () => {
  const assessed = assessLatestNationalStatisticsObservation({items: [observation("baseline")]});
  assert.ok(assessed);
  assert.equal(assessed.id, "baseline");
  assert.deepEqual(assessed.statistics, counts);
  assert.equal(assessLatestNationalStatisticsObservation({items: []}), undefined);
  assert.throws(
    () => assessLatestNationalStatisticsObservation({items: [observation("a"), observation("b")]}),
    /zero or one item/,
  );
});

test("national command oracle keeps nonterminal statuses pending", () => {
  const pending = assessNationalStatisticsCommandSubmission(status("PENDING"));
  assert.deepEqual(pending, {
    state: "pending",
    commandId: "command-1",
    statusCode: "PENDING",
    legacyAcceptedResult: false,
  });
  assert.doesNotThrow(() => assertNationalRefreshPendingControl(pending, {
    enabled: false,
    ariaBusy: "true",
  }));
  assert.throws(
    () => assertNationalRefreshPendingControl(pending, {enabled: true, ariaBusy: "true"}),
    /not disabled and busy while command command-1 was PENDING/,
  );
  assert.throws(
    () => assertNationalRefreshPendingControl(pending, {enabled: false, ariaBusy: "false"}),
    /aria-busy=false/,
  );
  assert.deepEqual(assessNationalStatisticsCommandStatus({items: [
    status("PENDING"),
    status("EXECUTING"),
    status("ACCEPTED"),
  ]}, "command-1"), {
    state: "pending",
    commandId: "command-1",
    statusCode: "ACCEPTED",
    legacyAcceptedResult: false,
  });
});

test("national command oracle requires a result on terminal and legacy-success statuses", () => {
  assert.deepEqual(assessNationalStatisticsCommandStatus({items: [
    status("PENDING"),
    status("COMPLETED", "observation-new"),
  ]}, "command-1"), {
    state: "complete",
    commandId: "command-1",
    statusCode: "COMPLETED",
    observationId: "observation-new",
    legacyAcceptedResult: false,
  });
  assert.deepEqual(assessNationalStatisticsCommandStatus({items: [
    status("ACCEPTED", "observation-legacy"),
  ]}, "command-1"), {
    state: "complete",
    commandId: "command-1",
    statusCode: "ACCEPTED",
    observationId: "observation-legacy",
    legacyAcceptedResult: true,
  });
  assert.throws(
    () => assessNationalStatisticsCommandStatus({items: [status("COMPLETED")]}, "command-1"),
    /completed without an observation result/,
  );
});

test("national command oracle rejects every unsuccessful terminal status", () => {
  for (const terminal of ["FAILED", "REJECTED", "CANCELED", "CANCELLED"]) {
    assert.throws(
      () => assessNationalStatisticsCommandStatus({items: [{...status(terminal), message: "fixture"}]}, "command-1"),
      new RegExp(`ended ${terminal}: fixture`),
    );
  }
  assert.throws(
    () => assessNationalStatisticsCommandStatus({items: [
      status("COMPLETED", "observation-new"),
      status("FAILED"),
    ]}, "command-1"),
    /ended FAILED/,
  );
});

test("national command oracle fails closed on identity and result ambiguity", () => {
  assert.throws(
    () => assessNationalStatisticsCommandStatus({items: [
      {...status("PENDING"), "command@id": "another-command"},
    ]}, "command-1"),
    /another-command, not command-1/,
  );
  assert.throws(
    () => assessNationalStatisticsCommandStatus({items: [{
      ...status("COMPLETED"),
      results: [{"observation@id": "one"}, {"observation@id": "two"}],
    }]}, "command-1"),
    /exactly one result observation/,
  );
});

test("national refresh requires a new exact observation with nondecreasing server times", () => {
  const baseline = assessLatestNationalStatisticsObservation({
    items: [observation("baseline", "2026-10-23T16:00:00Z")],
  });
  assert.ok(baseline);
  const refreshed = assessExactNationalStatisticsObservation(
    observation("refreshed", "2026-10-23T17:00:00Z"),
    "refreshed",
  );
  assert.doesNotThrow(() => assertFreshNationalStatisticsObservation(baseline, refreshed));
  assert.doesNotThrow(() => assertFreshNationalStatisticsObservation(undefined, refreshed));
  assert.doesNotThrow(() => assertFreshNationalStatisticsObservation(
    baseline,
    {...refreshed, resultTime: baseline.resultTime, phenomenonTime: baseline.phenomenonTime},
  ));
  assert.throws(
    () => assertFreshNationalStatisticsObservation(baseline, {...refreshed, id: "baseline"}),
    /reused the baseline/,
  );
  assert.throws(
    () => assertFreshNationalStatisticsObservation(
      baseline,
      {...refreshed, resultTime: "2026-10-23T15:59:59Z"},
    ),
    /result time older than its baseline/,
  );
  assert.throws(
    () => assertFreshNationalStatisticsObservation(
      baseline,
      {...refreshed, phenomenonTime: "2026-10-23T15:59:59Z"},
    ),
    /phenomenon time older than its baseline/,
  );
});

test("national refresh control contract requires disabled busy pending and enabled idle completion", () => {
  const completed = {enabled: true, ariaBusy: "false"};
  assert.equal(isNationalRefreshCompletedControl(completed), true);
  assert.doesNotThrow(() => assertNationalRefreshCompletedControl(completed));
  for (const invalid of [
    {enabled: false, ariaBusy: "false"},
    {enabled: true, ariaBusy: "true"},
    {enabled: true, ariaBusy: null},
  ]) {
    assert.equal(isNationalRefreshCompletedControl(invalid), false);
    assert.throws(() => assertNationalRefreshCompletedControl(invalid), /enabled and idle/);
  }
});

test("national refresh stable Playwright locator survives its accessible-name change", {
  timeout: 15_000,
}, async () => {
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH?.trim();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? {executablePath} : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<button aria-busy="false">Refresh Statistics</button>');
    const control = page.locator(NATIONAL_REFRESH_CONTROL_SELECTOR);
    assert.equal(await control.count(), 1);
    await control.evaluate((element) => {
      const button = element as HTMLButtonElement;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "Refreshing statistics...";
    });
    assert.equal(await control.count(), 1);
    assert.equal(await control.isEnabled(), false);
    assert.equal(await control.getAttribute("aria-busy"), "true");
    assert.equal(await page.getByRole("button", {name: "Refresh Statistics"}).count(), 0);
  } finally {
    await browser.close();
  }
});

test("Viewer exact-observation response oracle requires the expected origin, path, and HTTP success", () => {
  const collection = "https://oscar.test/sensorhub/api/observations?resultTime=latest";
  assert.deepEqual(classifyNationalStatisticsViewerObservationResponse(
    "GET",
    "https://oscar.test/sensorhub/api/observations/observation-42",
    200,
    collection,
  ), {
    observationId: "observation-42",
    status: 200,
    successful: true,
  });
  assert.deepEqual(classifyNationalStatisticsViewerObservationResponse(
    "GET",
    "https://oscar.test/sensorhub/api/observations/observation-42",
    503,
    collection,
  ), {
    observationId: "observation-42",
    status: 503,
    successful: false,
  });
  for (const [method, url] of [
    ["POST", "https://oscar.test/sensorhub/api/observations/observation-42"],
    ["GET", "https://other.test/sensorhub/api/observations/observation-42"],
    ["GET", "https://oscar.test/sensorhub/api/observations"],
    ["GET", "https://oscar.test/sensorhub/api/observations/observation-42/frame"],
    ["GET", "https://oscar.test/sensorhub/api/other/observation-42"],
  ] as const) {
    assert.equal(classifyNationalStatisticsViewerObservationResponse(
      method,
      url,
      200,
      collection,
    ), undefined);
  }
});

test("rendered national row comparison is exact and supports grouped digits", () => {
  const rendered = parseRenderedNationalStatistics({
    numGammaAlarms: "1",
    numNeutronAlarms: "2",
    numGammaNeutronAlarms: "3",
    numOccupancies: "4",
    numTampers: "5",
    numGammaFaults: "6",
    numNeutronFaults: "7",
    numFaults: "8",
  });
  assert.equal(nationalStatisticsEqual(rendered, counts), true);
  assert.equal(nationalStatisticsEqual({...rendered, numFaults: 9}, counts), false);
  assert.equal(parseRenderedNationalStatistics({...Object.fromEntries(
    Object.entries(counts).map(([field, value]) => [field, String(value)]),
  ), numOccupancies: "1,234"} as Record<keyof typeof counts, string>).numOccupancies, 1234);
  assert.throws(
    () => parseRenderedNationalStatistics({...Object.fromEntries(
      Object.entries(counts).map(([field, value]) => [field, String(value)]),
    ), numFaults: "unknown"} as Record<keyof typeof counts, string>),
    /not a non-negative integer/,
  );
});

test("national statistics completion deadline is a hang guard of at least fifteen minutes", () => {
  assert.ok(NATIONAL_STATISTICS_COMPLETION_TIMEOUT_MS >= 15 * 60 * 1_000);
});
