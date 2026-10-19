import {
  REQUIRED_OPERATIONAL_VIEW_KEYS,
  type LaneConfigOracle,
} from "./lane-config.js";
import type {CapabilityMode} from "./types.js";

export interface HttpCacheObservation {
  status: number;
  cacheControl: string;
}

export interface ViewerCacheAssessment {
  authenticatedAssetValid: boolean;
  serviceWorkerValid: boolean;
  unauthenticatedAssetProtected: boolean;
  unauthenticatedAssetNotCacheable: boolean;
  passed: boolean;
}

function cacheDirectives(value: string): string[] {
  return value.toLowerCase().split(",").map((directive) => directive.trim()).filter(Boolean);
}

function hasDirective(directives: readonly string[], name: string): boolean {
  return directives.some((directive) => directive === name || directive.startsWith(`${name}=`));
}

function positiveLifetime(directives: readonly string[]): boolean {
  return directives.some((directive) => {
    const match = /^(?:s-maxage|max-age)\s*=\s*"?(\d+)"?$/.exec(directive);
    return match ? Number(match[1]) > 0 : false;
  });
}

export function assessViewerCachePolicy(input: {
  authenticatedAsset: HttpCacheObservation;
  serviceWorker: HttpCacheObservation;
  unauthenticatedAsset: HttpCacheObservation;
}): ViewerCacheAssessment {
  const assetDirectives = cacheDirectives(input.authenticatedAsset.cacheControl);
  const serviceWorkerDirectives = cacheDirectives(input.serviceWorker.cacheControl);
  const unauthenticatedDirectives = cacheDirectives(input.unauthenticatedAsset.cacheControl);

  const authenticatedAssetValid = input.authenticatedAsset.status >= 200 &&
    input.authenticatedAsset.status < 300 &&
    hasDirective(assetDirectives, "private") &&
    assetDirectives.includes("max-age=31536000") &&
    hasDirective(assetDirectives, "immutable") &&
    !hasDirective(assetDirectives, "public");
  const serviceWorkerValid = input.serviceWorker.status >= 200 &&
    input.serviceWorker.status < 300 &&
    hasDirective(serviceWorkerDirectives, "no-cache") &&
    !hasDirective(serviceWorkerDirectives, "immutable") &&
    !positiveLifetime(serviceWorkerDirectives);
  const unauthenticatedAssetProtected = input.unauthenticatedAsset.status === 401 ||
    input.unauthenticatedAsset.status === 403;
  const unauthenticatedAssetNotCacheable =
    !hasDirective(unauthenticatedDirectives, "public") &&
    !hasDirective(unauthenticatedDirectives, "immutable") &&
    !positiveLifetime(unauthenticatedDirectives);

  return {
    authenticatedAssetValid,
    serviceWorkerValid,
    unauthenticatedAssetProtected,
    unauthenticatedAssetNotCacheable,
    passed: authenticatedAssetValid && serviceWorkerValid &&
      unauthenticatedAssetProtected && unauthenticatedAssetNotCacheable,
  };
}

export interface OperationalViewScopePair {
  assignedView: string;
  nonMemberView: string;
}

export function scopedUuidOperationalViewChecksEnabled(
  mode: CapabilityMode,
  runtimeCapabilityAvailable: boolean,
): boolean {
  return mode === "required" || (mode === "auto" && runtimeCapabilityAvailable);
}

export function operationalViewScopePair(
  oracle: LaneConfigOracle,
  laneName: string,
): OperationalViewScopePair {
  const lane = oracle.lanes.find((candidate) => candidate.name === laneName);
  if (!lane) throw new Error(`Lane membership oracle does not contain ${laneName}`);

  const assignedView = lane.operationalViews.find((view) =>
    oracle.lanesByView.get(view)?.includes(laneName));
  if (!assignedView) {
    throw new Error(`Lane membership oracle does not assign ${laneName} to a known operational view`);
  }

  const knownViews = [...new Set([
    ...REQUIRED_OPERATIONAL_VIEW_KEYS,
    ...[...oracle.lanesByView.keys()].sort(),
  ])];
  const nonMemberView = knownViews.find((view) => {
    const members = oracle.lanesByView.get(view);
    return Boolean(members?.length) && !members?.includes(laneName);
  });
  if (!nonMemberView) {
    throw new Error(`Lane membership oracle has no non-member operational view for ${laneName}`);
  }

  return {assignedView, nonMemberView};
}

export interface AlarmChartCanvasSnapshot {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  gammaPlotPixels: number;
  neutronPlotPixels: number;
}

export type AlarmChartSeries = "gamma" | "neutron";

export function importedAlarmChartsRendered(
  expectedSeries: readonly AlarmChartSeries[],
  snapshots: readonly AlarmChartCanvasSnapshot[],
): boolean {
  return expectedSeries.length > 0 && snapshots.length === expectedSeries.length && snapshots.every((snapshot, index) => {
    const visible = snapshot.width > 0 && snapshot.height > 0 &&
      snapshot.clientWidth > 0 && snapshot.clientHeight > 0;
    const series = expectedSeries[index];
    const seriesPixels = series === "gamma"
      ? snapshot.gammaPlotPixels
      : series === "neutron"
        ? snapshot.neutronPlotPixels
        : 0;
    return visible && seriesPixels > 0;
  });
}

export function canonicalAlarmTransferDocumentJson(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new Error("Alarm transfer document must be an object");
  }
  const document = value as Record<string, unknown>;
  if (!document.payload || typeof document.payload !== "object" ||
    !document.integrity || typeof document.integrity !== "object" ||
    typeof document.transport !== "string") {
    throw new Error("Alarm transfer document is missing payload, integrity, or transport");
  }
  return JSON.stringify({
    payload: document.payload,
    integrity: document.integrity,
    transport: document.transport,
  });
}
