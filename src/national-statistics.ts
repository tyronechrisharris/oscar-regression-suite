export const NATIONAL_STATISTICS_OBSERVED_PROPERTY = "http://www.opengis.net/def/NumOccupancies";
export const NATIONAL_REFRESH_CONTROL_SELECTOR = "button[aria-busy]";

// This is only a deadlock guard. A refresh passes when its own durable command
// reaches a successful terminal status and its exact observation is rendered.
export const NATIONAL_STATISTICS_COMPLETION_TIMEOUT_MS = 15 * 60 * 1_000;

export const NATIONAL_STATISTICS_FIELDS = [
  "numGammaAlarms",
  "numNeutronAlarms",
  "numGammaNeutronAlarms",
  "numOccupancies",
  "numTampers",
  "numGammaFaults",
  "numNeutronFaults",
  "numFaults",
] as const;

export type NationalStatisticsField = typeof NATIONAL_STATISTICS_FIELDS[number];
export type NationalStatistics = Record<NationalStatisticsField, number>;

export interface NationalStatisticsObservation {
  id: string;
  phenomenonTime: string;
  resultTime: string;
  statistics: NationalStatistics;
}

export interface NationalStatisticsCommandProgress {
  state: "pending" | "complete";
  commandId: string;
  statusCode: string;
  observationId?: string;
  legacyAcceptedResult: boolean;
}

export interface NationalRefreshControlState {
  enabled: boolean;
  ariaBusy: string | null;
}

export interface NationalStatisticsViewerObservationResponse {
  observationId: string;
  status: number;
  successful: boolean;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function statistics(value: unknown, field: string): NationalStatistics {
  const record = object(value, field);
  return Object.fromEntries(NATIONAL_STATISTICS_FIELDS.map(name => [
    name,
    count(record[name], `${field}.${name}`),
  ])) as NationalStatistics;
}

function observation(value: unknown, field: string): NationalStatisticsObservation {
  const record = object(value, field);
  const result = object(record.result, `${field}.result`);
  const phenomenonTime = nonEmptyString(record.phenomenonTime, `${field}.phenomenonTime`);
  const resultTime = nonEmptyString(record.resultTime, `${field}.resultTime`);
  if (!Number.isFinite(Date.parse(phenomenonTime)) || !Number.isFinite(Date.parse(resultTime))) {
    throw new Error(`${field} must have valid phenomenonTime and resultTime timestamps`);
  }
  return {
    id: nonEmptyString(record.id, `${field}.id`),
    phenomenonTime,
    resultTime,
    statistics: statistics(result.allTime, `${field}.result.allTime`),
  };
}

export function assessLatestNationalStatisticsObservation(
  value: unknown,
): NationalStatisticsObservation | undefined {
  const collection = object(value, "national statistics observation collection");
  if (!Array.isArray(collection.items) || collection.items.length > 1) {
    throw new Error("National statistics latest-observation query must return zero or one item");
  }
  if (collection.items.length === 0) return undefined;
  return observation(collection.items[0], "national statistics latest observation");
}

export function assessExactNationalStatisticsObservation(
  value: unknown,
  expectedObservationId: string,
): NationalStatisticsObservation {
  const assessed = observation(value, "exact national statistics observation");
  if (assessed.id !== expectedObservationId) {
    throw new Error(
      `Exact national statistics observation ID ${assessed.id} does not match ${expectedObservationId}`,
    );
  }
  return assessed;
}

function statusRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => object(item, `command status[${index}]`));
  }
  const record = object(value, "command status response");
  if (Array.isArray(record.items)) {
    return record.items.map((item, index) => object(item, `command status.items[${index}]`));
  }
  return [record];
}

function observationIdFromStatus(status: Record<string, unknown>, field: string): string | undefined {
  if (status.results === undefined) return undefined;
  if (!Array.isArray(status.results)) throw new Error(`${field}.results must be an array`);
  const observationIds = status.results.flatMap((result, index) => {
    const item = object(result, `${field}.results[${index}]`);
    if (item["observation@id"] === undefined) return [];
    return [nonEmptyString(item["observation@id"], `${field}.results[${index}].observation@id`)];
  });
  if (observationIds.length > 1 || new Set(observationIds).size > 1) {
    throw new Error(`${field} must identify exactly one result observation`);
  }
  return observationIds[0];
}

function assessStatuses(value: unknown, expectedCommandId?: string): NationalStatisticsCommandProgress {
  const records = statusRecords(value);
  if (records.length === 0) throw new Error("Command status response contains no status records");

  let commandId = expectedCommandId;
  let successful: NationalStatisticsCommandProgress | undefined;
  let latestNonTerminal = "PENDING";
  const allowedNonTerminal = new Set(["PENDING", "ACCEPTED", "SCHEDULED", "UPDATED", "EXECUTING"]);
  const failedTerminal = new Set(["FAILED", "REJECTED", "CANCELED", "CANCELLED"]);

  for (const [index, record] of records.entries()) {
    const field = `command status[${index}]`;
    const recordCommandId = nonEmptyString(record["command@id"], `${field}.command@id`);
    if (commandId === undefined) commandId = recordCommandId;
    if (recordCommandId !== commandId) {
      throw new Error(`${field} belongs to command ${recordCommandId}, not ${commandId}`);
    }

    const statusCode = nonEmptyString(record.statusCode, `${field}.statusCode`).toUpperCase();
    const resultObservationId = observationIdFromStatus(record, field);
    const message = typeof record.message === "string" && record.message.trim()
      ? `: ${record.message.trim()}`
      : "";
    if (failedTerminal.has(statusCode)) {
      throw new Error(`National statistics command ${commandId} ended ${statusCode}${message}`);
    }
    if (statusCode === "COMPLETED") {
      if (!resultObservationId) {
        throw new Error(`National statistics command ${commandId} completed without an observation result`);
      }
      const candidate: NationalStatisticsCommandProgress = {
        state: "complete",
        commandId,
        statusCode,
        observationId: resultObservationId,
        legacyAcceptedResult: false,
      };
      if (successful?.observationId && successful.observationId !== resultObservationId) {
        throw new Error(`National statistics command ${commandId} reported conflicting result observations`);
      }
      successful = candidate;
      continue;
    }
    if (statusCode === "ACCEPTED" && resultObservationId) {
      const candidate: NationalStatisticsCommandProgress = {
        state: "complete",
        commandId,
        statusCode,
        observationId: resultObservationId,
        legacyAcceptedResult: true,
      };
      if (successful?.observationId && successful.observationId !== resultObservationId) {
        throw new Error(`National statistics command ${commandId} reported conflicting result observations`);
      }
      successful = successful?.statusCode === "COMPLETED" ? successful : candidate;
      continue;
    }
    if (!allowedNonTerminal.has(statusCode)) {
      throw new Error(`National statistics command ${commandId} reported unknown status ${statusCode}`);
    }
    latestNonTerminal = statusCode;
  }

  if (!commandId) throw new Error("National statistics command response omitted command@id");
  return successful ?? {
    state: "pending",
    commandId,
    statusCode: latestNonTerminal,
    legacyAcceptedResult: false,
  };
}

export function assessNationalStatisticsCommandSubmission(value: unknown): NationalStatisticsCommandProgress {
  return assessStatuses(value);
}

export function assessNationalStatisticsCommandStatus(
  value: unknown,
  expectedCommandId: string,
): NationalStatisticsCommandProgress {
  return assessStatuses(value, expectedCommandId);
}

export function assertNationalRefreshPendingControl(
  progress: NationalStatisticsCommandProgress,
  control: NationalRefreshControlState,
): void {
  if (progress.state !== "pending") return;
  if (control.enabled || control.ariaBusy !== "true") {
    throw new Error(
      `Refresh Statistics was not disabled and busy while command ${progress.commandId} was ` +
      `${progress.statusCode} (enabled=${control.enabled}; aria-busy=${control.ariaBusy ?? "missing"})`,
    );
  }
}

export function isNationalRefreshCompletedControl(control: NationalRefreshControlState): boolean {
  return control.enabled && control.ariaBusy === "false";
}

export function assertNationalRefreshCompletedControl(control: NationalRefreshControlState): void {
  if (!isNationalRefreshCompletedControl(control)) {
    throw new Error(
      `Refresh Statistics did not return to enabled and idle ` +
      `(enabled=${control.enabled}; aria-busy=${control.ariaBusy ?? "missing"})`,
    );
  }
}

export function assertFreshNationalStatisticsObservation(
  baseline: NationalStatisticsObservation | undefined,
  refreshed: NationalStatisticsObservation,
): void {
  if (!baseline) return;
  if (refreshed.id === baseline.id) {
    throw new Error("National statistics refresh reused the baseline observation ID");
  }
  if (Date.parse(refreshed.resultTime) < Date.parse(baseline.resultTime)) {
    throw new Error("National statistics refresh returned a result time older than its baseline");
  }
  if (Date.parse(refreshed.phenomenonTime) < Date.parse(baseline.phenomenonTime)) {
    throw new Error("National statistics refresh returned a phenomenon time older than its baseline");
  }
}

export function classifyNationalStatisticsViewerObservationResponse(
  method: string,
  responseUrl: string,
  status: number,
  expectedObservationCollectionUrl: string,
): NationalStatisticsViewerObservationResponse | undefined {
  if (method !== "GET") return undefined;

  let response: URL;
  let expected: URL;
  try {
    response = new URL(responseUrl);
    expected = new URL(expectedObservationCollectionUrl);
  } catch {
    return undefined;
  }
  if (response.origin !== expected.origin) return undefined;

  const collectionPath = expected.pathname.replace(/\/+$/, "");
  const exactPrefix = `${collectionPath}/`;
  if (!response.pathname.startsWith(exactPrefix)) return undefined;
  const encodedObservationId = response.pathname.slice(exactPrefix.length);
  if (!encodedObservationId || encodedObservationId.includes("/")) return undefined;

  let observationId: string;
  try {
    observationId = decodeURIComponent(encodedObservationId);
  } catch {
    return undefined;
  }
  if (!observationId.trim()) return undefined;

  return {
    observationId,
    status,
    successful: status >= 200 && status < 300,
  };
}

export function parseRenderedNationalStatistics(
  values: Record<NationalStatisticsField, string>,
): NationalStatistics {
  return Object.fromEntries(NATIONAL_STATISTICS_FIELDS.map(field => {
    const normalized = values[field].replaceAll(",", "").trim();
    if (!/^\d+$/.test(normalized)) {
      throw new Error(`Rendered national statistics field ${field} is not a non-negative integer`);
    }
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`Rendered national statistics field ${field} exceeds the safe integer range`);
    }
    return [field, parsed];
  })) as NationalStatistics;
}

export function nationalStatisticsEqual(left: NationalStatistics, right: NationalStatistics): boolean {
  return NATIONAL_STATISTICS_FIELDS.every(field => left[field] === right[field]);
}
