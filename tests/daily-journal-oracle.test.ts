import assert from "node:assert/strict";
import test from "node:test";
import {
  assessDailyJournalStatus,
  type DailyJournalStatus,
} from "../src/daily-journal-oracle.js";

const currentDay: DailyJournalStatus = {
  publications: 0,
  manifests: 0,
  validatedManifests: 0,
  manifestFailures: 0,
  partialFiles: 0,
  unsafeLinks: 0,
  unsafeEntries: 0,
  bounded: true,
  inventoryEntries: 600,
  zoneId: "UTC",
  currentDate: "2026-10-18",
  eligiblePriorDayDirectories: 0,
  currentDayDirectories: 50,
  currentDayOpenSegments: 50,
  currentDaySealedSegments: 500,
  currentDayBytes: 64_000,
  journalIntegrityFailures: 0,
  openSegments: 50,
  sealedSegments: 500,
};

test("daily journal accepts a durable current day before its configured-zone publication boundary", () => {
  assert.deepEqual(assessDailyJournalStatus(currentDay), {
    passed: true,
    state: "publication-not-yet-eligible",
    explanation: "publication not yet eligible: no completed UTC day; 550 durable current-day segment(s) passed header and layout checks",
  });
});

test("daily journal requires an exact publication as soon as a prior day is eligible", () => {
  const eligible = {...currentDay, eligiblePriorDayDirectories: 1};
  assert.equal(assessDailyJournalStatus(eligible).passed, false);

  const published = {
    ...eligible,
    publications: 1,
    manifests: 1,
    validatedManifests: 1,
  };
  assert.deepEqual(assessDailyJournalStatus(published), {
    passed: true,
    state: "published",
    explanation: "1 exact daily CSV/manifest pair(s) validated",
  });
});

test("daily journal never hides invalid publications or unsafe current segments", () => {
  for (const value of [
    {...currentDay, manifests: 1},
    {...currentDay, journalIntegrityFailures: 1},
    {...currentDay, currentDayBytes: 100},
    {...currentDay, partialFiles: 1},
    {...currentDay, currentDayOpenSegments: 0, currentDaySealedSegments: 0},
  ]) assert.equal(assessDailyJournalStatus(value).passed, false);
});
