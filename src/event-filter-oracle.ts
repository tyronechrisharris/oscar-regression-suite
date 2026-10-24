export const ADVANCED_DATE_FILTER_PAGE_SIZE = 15;
export const ADVANCED_DATE_FILTER_MAX_BYTES = 2 * 1024 * 1024;

export interface AdvancedDateFilterProbeUrls {
  countUrl: string;
  pageUrl: string;
  cutoff: string;
  sourceFilter: string;
  datastreamCount: number;
}

export interface AdvancedDateFilterAssessment {
  passed: boolean;
  count: number | null;
  pageItems: number;
  validStartTimes: number;
  beforeCutoff: number;
  reason: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalInstant(value: unknown, field: string): {text: string; epochMs: number} {
  if (typeof value !== "string" || value.length > 64 || /[\x00\r\n]/.test(value)) {
    throw new Error(`${field} must be one bounded ISO timestamp`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) throw new Error(`${field} is not a valid timestamp`);
  return {text: new Date(epochMs).toISOString(), epochMs};
}

export function eventObservationStartTimes(payload: unknown): string[] {
  const document = record(payload);
  if (!document || !Array.isArray(document.items) || document.items.length === 0 ||
      document.items.length > ADVANCED_DATE_FILTER_PAGE_SIZE) {
    throw new Error("event observation page must contain one bounded nonempty items array");
  }
  return document.items.map((item, index) => {
    const observation = record(item);
    const result = record(observation?.result);
    return canonicalInstant(result?.startTime, `items[${index}].result.startTime`).text;
  });
}

export function deriveExclusiveDateCutoff(payload: unknown): string {
  const startTimes = eventObservationStartTimes(payload);
  const maximum = Math.max(...startTimes.map(value => Date.parse(value)));
  if (!Number.isSafeInteger(maximum) || maximum >= Date.parse("9999-12-31T23:59:59.998Z")) {
    throw new Error("event observation start time cannot produce a bounded exclusive cutoff");
  }
  return new Date(maximum + 1).toISOString();
}

function validateSourceQuery(source: URL): {datastreamCount: number; sourceFilter: string} {
  if (source.protocol !== "https:" || source.username || source.password || source.hash ||
      !source.pathname.endsWith("/sensorhub/api/observations")) {
    throw new Error("event filter source must be a credential-free OSCAR HTTPS observations URL");
  }
  const datastreams = (source.searchParams.get("dataStream") ?? "").split(",");
  if (datastreams.length < 1 || datastreams.length > 100 ||
      datastreams.some(value => !/^[0-9a-v]{2,128}$/.test(value)) ||
      new Set(datastreams).size !== datastreams.length) {
    throw new Error("event filter source must contain 1-100 unique bounded OSH datastream IDs");
  }
  const resultTime = source.searchParams.get("resultTime") ?? "";
  if (!resultTime || resultTime.length > 128 || /[\x00\r\n]/.test(resultTime)) {
    throw new Error("event filter source is missing its bounded resultTime fence");
  }
  const sourceFilter = source.searchParams.get("filter") ?? "";
  if (sourceFilter.length > 2048 || /[\x00\r\n]/.test(sourceFilter)) {
    throw new Error("event filter source contains an unsafe filter");
  }
  return {datastreamCount: datastreams.length, sourceFilter};
}

export function isEventObservationPageUrl(rawUrl: string, expectedOrigin: string): boolean {
  try {
    const source = new URL(rawUrl);
    const origin = new URL(expectedOrigin).origin;
    if (source.origin !== origin || !source.pathname.endsWith("/sensorhub/api/observations")) return false;
    if (source.searchParams.get("order") !== "desc" ||
        source.searchParams.get("offset") !== "0" ||
        source.searchParams.get("limit") !== String(ADVANCED_DATE_FILTER_PAGE_SIZE)) return false;
    validateSourceQuery(source);
    return true;
  } catch {
    return false;
  }
}

export function hasDashboardAlarmPredicate(rawUrl: string): boolean {
  try {
    const filter = new URL(rawUrl).searchParams.get("filter") ?? "";
    return /gammaAlarm\s*=\s*true/.test(filter) &&
      /neutronAlarm\s*=\s*true/.test(filter) &&
      /adjudicatedIdsCount\s*=\s*0/.test(filter);
  } catch {
    return false;
  }
}

export function buildAdvancedDateFilterProbeUrls(
  sourceUrl: string,
  expectedOrigin: string,
  cutoffValue: string,
): AdvancedDateFilterProbeUrls {
  const source = new URL(sourceUrl);
  if (source.origin !== new URL(expectedOrigin).origin) {
    throw new Error("event filter source origin does not match the authenticated Viewer target");
  }
  const {datastreamCount, sourceFilter} = validateSourceQuery(source);
  const cutoff = canonicalInstant(cutoffValue, "advanced date-filter cutoff").text;
  const dateFilter = `startTime<'${cutoff}'`;
  const combinedFilter = sourceFilter ? `(${sourceFilter}) AND (${dateFilter})` : dateFilter;

  const page = new URL(source.toString());
  page.searchParams.set("filter", combinedFilter);
  page.searchParams.set("order", "desc");
  page.searchParams.set("offset", "0");
  page.searchParams.set("limit", String(ADVANCED_DATE_FILTER_PAGE_SIZE));

  const count = new URL(page.toString());
  count.pathname += "/count";
  count.searchParams.delete("order");
  count.searchParams.delete("offset");
  count.searchParams.delete("limit");

  return {
    countUrl: count.toString(),
    pageUrl: page.toString(),
    cutoff,
    sourceFilter,
    datastreamCount,
  };
}

function observationCount(payload: unknown): number | null {
  const value = record(payload)?.count;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function assessAdvancedDateFilterResponses(
  countStatus: number,
  countPayload: unknown,
  pageStatus: number,
  pagePayload: unknown,
  cutoffValue: string,
): AdvancedDateFilterAssessment {
  const count = observationCount(countPayload);
  if (countStatus < 200 || countStatus >= 300) {
    return {passed: false, count, pageItems: 0, validStartTimes: 0, beforeCutoff: 0,
      reason: `count returned HTTP ${countStatus}`};
  }
  if (pageStatus < 200 || pageStatus >= 300) {
    return {passed: false, count, pageItems: 0, validStartTimes: 0, beforeCutoff: 0,
      reason: `page returned HTTP ${pageStatus}`};
  }
  if (count === null || count === 0) {
    return {passed: false, count, pageItems: 0, validStartTimes: 0, beforeCutoff: 0,
      reason: count === 0 ? "count returned zero" : "count payload is invalid"};
  }

  let startTimes: string[];
  try {
    startTimes = eventObservationStartTimes(pagePayload);
  } catch (error) {
    return {passed: false, count, pageItems: 0, validStartTimes: 0, beforeCutoff: 0,
      reason: error instanceof Error ? error.message : "page payload is invalid"};
  }
  const cutoff = canonicalInstant(cutoffValue, "advanced date-filter cutoff").epochMs;
  const beforeCutoff = startTimes.filter(value => Date.parse(value) < cutoff).length;
  const passed = count >= startTimes.length && beforeCutoff === startTimes.length;
  return {
    passed,
    count,
    pageItems: startTimes.length,
    validStartTimes: startTimes.length,
    beforeCutoff,
    reason: passed ? "" : count < startTimes.length
      ? "count is smaller than the returned page"
      : "one or more page start times did not precede the cutoff",
  };
}
