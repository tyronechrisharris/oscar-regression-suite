export interface HealthObservationBatch {
  streamIds: string[];
  limit: number | null;
}

export interface ConnectionRewriteSummary {
  matched: number;
  offlineMatched: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemProperties(item: JsonRecord): JsonRecord {
  return isRecord(item.properties) ? item.properties : item;
}

function connectionResult(item: JsonRecord): JsonRecord | undefined {
  const properties = itemProperties(item);
  return isRecord(item.result)
    ? item.result
    : isRecord(properties.result)
      ? properties.result
      : undefined;
}

function observationStreamId(item: JsonRecord): string | null {
  const properties = itemProperties(item);
  const value = item["datastream@id"] ?? properties["datastream@id"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Recognize the batched latest-observation requests used by the shared lane
 * health snapshot. Other observation traffic must not affect the polling
 * concurrency oracle.
 */
export function parseHealthObservationBatch(rawUrl: string): HealthObservationBatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!/\/observations\/?$/.test(url.pathname) ||
      url.searchParams.get("resultTime")?.toLowerCase() !== "latest") {
    return null;
  }

  const streamIds = (url.searchParams.get("dataStream") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (streamIds.length === 0) return null;

  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit === null ? null : Number(rawLimit);
  return {
    streamIds,
    limit: parsedLimit !== null && Number.isInteger(parsedLimit) ? parsedLimit : null,
  };
}

/**
 * Browser-only deterministic fixture used to prove that RPM and every camera
 * render independently as Offline. It rewrites connection observations in a
 * copied HTTP response and never changes SensorHub or emulator state.
 */
export function forceConnectionObservationsOffline(payload: unknown): number {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return 0;

  let matched = 0;
  for (const item of payload.items) {
    if (!isRecord(item)) continue;
    const result = connectionResult(item);
    if (!result) continue;

    if (typeof result.isConnected === "boolean") {
      result.isConnected = false;
      matched++;
    } else if (typeof result.connection === "boolean") {
      result.connection = false;
      matched++;
    }
  }
  return matched;
}

/**
 * Drive one identified connection observation Offline while normalizing every
 * other connection observation to Online. The target is a datastream ID read
 * from the live camera system metadata, so the fixture does not depend on API
 * result ordering or generated component IDs.
 */
export function forceSingleConnectionObservationOffline(
  payload: unknown,
  targetStreamId: string,
): ConnectionRewriteSummary {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return {matched: 0, offlineMatched: 0};
  }

  let matched = 0;
  let offlineMatched = 0;
  for (const item of payload.items) {
    if (!isRecord(item)) continue;
    const result = connectionResult(item);
    if (!result) continue;

    const hasIsConnected = typeof result.isConnected === "boolean";
    const hasConnection = typeof result.connection === "boolean";
    if (!hasIsConnected && !hasConnection) continue;

    const offline = observationStreamId(item) === targetStreamId;
    if (hasIsConnected) result.isConnected = !offline;
    if (hasConnection) result.connection = !offline;
    matched++;
    if (offline) offlineMatched++;
  }
  return {matched, offlineMatched};
}

/** Return connection-status datastream IDs from a raw or parser-wrapped API collection. */
export function connectionDataStreamIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];

  const ids = new Set<string>();
  for (const item of payload.items) {
    if (!isRecord(item)) continue;
    const nested = isRecord(item.properties) ? item.properties : undefined;
    const observedProperties = Array.isArray(item.observedProperties)
      ? item.observedProperties
      : nested?.observedProperties;
    if (!Array.isArray(observedProperties)) continue;
    const definitions = observedProperties
      .map((property) => isRecord(property) ? property.definition : undefined)
      .filter((definition): definition is string => typeof definition === "string");
    const isConnection = definitions.some((definition) =>
      definition === "http://www.opengis.net/def/ConnectionStatus" ||
      definition === "http://www.opengis.net/def/property/OGC/0/ConnectionStatus");
    const id = item.id ?? nested?.id;
    if (isConnection && typeof id === "string" && id.length > 0) ids.add(id);
  }
  return [...ids];
}
