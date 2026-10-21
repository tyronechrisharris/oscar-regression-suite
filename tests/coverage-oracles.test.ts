import assert from "node:assert/strict";
import {resolve} from "node:path";
import test from "node:test";
import {
  assessViewerCachePolicy,
  canonicalAlarmTransferDocumentJson,
  importedAlarmChartsRendered,
  liveLaneTelemetryChartsRendered,
  operationalViewScopePair,
  scopedUuidOperationalViewChecksEnabled,
} from "../src/coverage-oracles.js";
import {loadLaneConfigOracle, type LaneConfigOracle} from "../src/lane-config.js";

test("cache policy accepts private immutable assets and a non-cacheable protected error", () => {
  const result = assessViewerCachePolicy({
    authenticatedAsset: {
      status: 200,
      cacheControl: "private, max-age=31536000, immutable",
    },
    serviceWorker: {status: 200, cacheControl: "no-cache"},
    unauthenticatedAsset: {status: 401, cacheControl: ""},
  });

  assert.deepEqual(result, {
    authenticatedAssetValid: true,
    serviceWorkerValid: true,
    unauthenticatedAssetProtected: true,
    unauthenticatedAssetNotCacheable: true,
    passed: true,
  });
});

test("cache policy rejects public or long-lived authentication errors", () => {
  for (const cacheControl of [
    "private, max-age=31536000, immutable",
    "public, no-cache",
    "s-maxage=60",
  ]) {
    const result = assessViewerCachePolicy({
      authenticatedAsset: {status: 200, cacheControl: "private, max-age=31536000, immutable"},
      serviceWorker: {status: 200, cacheControl: "no-cache"},
      unauthenticatedAsset: {status: 401, cacheControl},
    });
    assert.equal(result.unauthenticatedAssetNotCacheable, false, cacheControl);
    assert.equal(result.passed, false, cacheControl);
  }

  const unprotected = assessViewerCachePolicy({
    authenticatedAsset: {status: 200, cacheControl: "private, max-age=31536000, immutable"},
    serviceWorker: {status: 200, cacheControl: "no-cache"},
    unauthenticatedAsset: {status: 200, cacheControl: "no-cache"},
  });
  assert.equal(unprotected.unauthenticatedAssetProtected, false);
  assert.equal(unprotected.passed, false);
});

test("operational-view probe chooses a real member view and a populated non-member view", () => {
  const oracle = loadLaneConfigOracle(resolve("fixtures/oscar-50-lane-config.csv"));
  assert.deepEqual(operationalViewScopePair(oracle, "Lane50"), {
    assignedView: "pedestrian",
    nonMemberView: "east-gate",
  });
  assert.deepEqual(operationalViewScopePair(oracle, "Lane01"), {
    assignedView: "east-gate",
    nonMemberView: "west-gate",
  });
});

test("operational-view probe rejects missing lanes and an oracle without a non-member scope", () => {
  const oracle = loadLaneConfigOracle(resolve("fixtures/oscar-50-lane-config.csv"));
  assert.throws(() => operationalViewScopePair(oracle, "Lane99"), /does not contain Lane99/);

  const oneViewOracle: LaneConfigOracle = {
    path: "fixture.csv",
    sha256: "fixture",
    lanes: [{name: "Lane01", uniqueId: "lane-01", operationalViews: ["east-gate"]}],
    lanesByView: new Map([["east-gate", ["Lane01"]]]),
  };
  assert.throws(
    () => operationalViewScopePair(oneViewOracle, "Lane01"),
    /no non-member operational view/,
  );
});

test("scoped UUID checks skip only disabled or auto-detected legacy view workflows", () => {
  assert.equal(scopedUuidOperationalViewChecksEnabled("disabled", true), false);
  assert.equal(scopedUuidOperationalViewChecksEnabled("auto", false), false);
  assert.equal(scopedUuidOperationalViewChecksEnabled("auto", true), true);
  assert.equal(scopedUuidOperationalViewChecksEnabled("required", false), true);
});

test("imported chart oracle requires the expected series color on each visible canvas", () => {
  const gamma = {
    width: 640, height: 320, clientWidth: 640, clientHeight: 320,
    gammaPlotPixels: 40, neutronPlotPixels: 0,
  };
  const neutron = {...gamma, gammaPlotPixels: 0, neutronPlotPixels: 30};
  const legendOnly = {...gamma, gammaPlotPixels: 0};
  assert.equal(importedAlarmChartsRendered(["gamma", "neutron"], [gamma, neutron]), true);
  assert.equal(importedAlarmChartsRendered(["gamma", "neutron"], [gamma]), false);
  assert.equal(importedAlarmChartsRendered(["gamma"], [legendOnly]), false);
  assert.equal(importedAlarmChartsRendered(["gamma", "neutron"], [neutron, gamma]), false);
  assert.equal(importedAlarmChartsRendered([], []), false);
});

test("live lane chart oracle requires painted Gamma and Neutron series, not empty canvases", () => {
  const gamma = {
    width: 640, height: 320, clientWidth: 640, clientHeight: 320,
    gammaPlotPixels: 40, neutronPlotPixels: 0,
  };
  const neutron = {...gamma, gammaPlotPixels: 0, neutronPlotPixels: 30};
  assert.equal(liveLaneTelemetryChartsRendered(gamma, neutron), true);
  assert.equal(liveLaneTelemetryChartsRendered({...gamma, gammaPlotPixels: 0}, neutron), false);
  assert.equal(liveLaneTelemetryChartsRendered(gamma, {...neutron, neutronPlotPixels: 0}), false);
  assert.equal(liveLaneTelemetryChartsRendered({...gamma, clientWidth: 0}, neutron), false);
});

test("canonical alarm document comparison ignores export-only QR metadata", () => {
  const canonical = {
    payload: {schema: "org.oscar.alarm-transfer", event: {observationId: "event-1"}},
    integrity: {algorithm: "SHA-256", digest: "abc"},
    transport: "OSCAR-ALARM:1:payload/digest",
  };
  assert.equal(
    canonicalAlarmTransferDocumentJson({...canonical, qrCharacters: 1170, qrFits: true}),
    canonicalAlarmTransferDocumentJson(canonical),
  );
  assert.notEqual(
    canonicalAlarmTransferDocumentJson(canonical),
    canonicalAlarmTransferDocumentJson({...canonical, transport: `${canonical.transport}-changed`}),
  );
  assert.throws(
    () => canonicalAlarmTransferDocumentJson({payload: canonical.payload}),
    /missing payload, integrity, or transport/,
  );
});
