import {publicObservationId} from "./public-observation-id.js";

const SAFE_CAMERA_UID = /^[A-Za-z0-9._:-]+$/;
const CAMERA_TOKEN = /^[A-Za-z0-9._-]+$/;
const CLIP_NAME = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])_([01]\d|2[0-3])-([0-5]\d)-([0-5]\d)_(\d{3})-g([1-9]\d*)\.mp4$/;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be nonblank text`);
  return value.trim();
}

/** Camera directory token used by OSCAR's FFmpeg video bucket. */
export function alarmCameraToken(cameraUid: string): string {
  const normalized = requiredText(cameraUid, "camera UID");
  if (!SAFE_CAMERA_UID.test(normalized)) {
    throw new Error(`camera UID contains unsupported path characters: ${normalized}`);
  }
  const token = normalized.replaceAll(":", "-");
  if (!CAMERA_TOKEN.test(token)) throw new Error(`camera UID does not produce a safe clip token: ${normalized}`);
  return token;
}

export interface AlarmVideoPath {
  cameraUid: string;
  cameraToken: string;
  path: string;
  timestamp: string;
  generation: number;
}

export interface AlarmVideoAssociation {
  eventId: string;
  paths: AlarmVideoPath[];
}

function systemCatalogItems(value: unknown): unknown[] {
  const collection = record(value, "systems catalog");
  const candidates = Array.isArray(collection.items)
    ? collection.items
    : Array.isArray(collection.features) ? collection.features : undefined;
  if (!candidates) throw new Error("systems catalog must contain an items array");
  return candidates;
}

/** Resolves one lane's authoritative OSH UID from the authenticated systems catalog. */
export function laneUidForSystemName(value: unknown, laneName: string): string {
  const expectedName = requiredText(laneName, "lane name");
  const matches: string[] = [];
  for (const [index, rawCandidate] of systemCatalogItems(value).entries()) {
    const candidate = record(rawCandidate, `systems catalog item ${index}`);
    const properties = candidate.properties && typeof candidate.properties === "object"
      ? record(candidate.properties, `systems catalog item ${index} properties`)
      : {};
    const nested = properties.properties && typeof properties.properties === "object"
      ? record(properties.properties, `systems catalog item ${index} nested properties`)
      : {};
    const nameValue = candidate.name ?? properties.name ?? nested.name;
    if (typeof nameValue !== "string" || nameValue.trim() !== expectedName) continue;
    const uid = requiredText(
      candidate.uid ?? candidate.uniqueId ?? properties.uid ?? properties.uniqueId ?? nested.uid ?? nested.uniqueId,
      `systems catalog lane ${expectedName} UID`,
    );
    if (!uid.startsWith("urn:osh:system:lane:")) continue;
    matches.push(uid);
  }
  if (matches.length !== 1) {
    throw new Error(`systems catalog resolved ${matches.length} lane UIDs for ${expectedName}; expected exactly one`);
  }
  return matches[0]!;
}

/**
 * Resolves the camera system UIDs that back the selected lane's Viewer camera
 * components.  Component IDs come from the lane card, while UIDs come from the
 * authenticated Connected Systems catalog; emulator stream IDs are deliberately
 * not accepted as camera identities.
 */
export function cameraUidsForSystemComponents(
  value: unknown,
  componentIds: readonly string[],
): string[] {
  const candidates = systemCatalogItems(value);

  const requested = componentIds.map((id, index) => requiredText(id, `camera component ID ${index}`));
  if (requested.length < 1) throw new Error("the reserved lane has no camera components");
  if (new Set(requested).size !== requested.length) {
    throw new Error("the reserved lane camera component list contains duplicates");
  }

  const uidById = new Map<string, string>();
  for (const [index, rawCandidate] of candidates.entries()) {
    const candidate = record(rawCandidate, `systems catalog item ${index}`);
    const properties = candidate.properties && typeof candidate.properties === "object"
      ? record(candidate.properties, `systems catalog item ${index} properties`)
      : {};
    const nested = properties.properties && typeof properties.properties === "object"
      ? record(properties.properties, `systems catalog item ${index} nested properties`)
      : {};
    const idValue = candidate.id ?? properties.id;
    if (typeof idValue !== "string" || !requested.includes(idValue.trim())) continue;
    const id = requiredText(idValue, `systems catalog item ${index} ID`);
    const uid = requiredText(
      candidate.uid ?? candidate.uniqueId ?? properties.uid ?? properties.uniqueId ?? nested.uid ?? nested.uniqueId,
      `systems catalog camera ${id} UID`,
    );
    alarmCameraToken(uid);
    if (uidById.has(id)) throw new Error(`systems catalog contains duplicate camera component ${id}`);
    uidById.set(id, uid);
  }

  const missing = requested.filter(id => !uidById.has(id));
  if (missing.length > 0) {
    throw new Error(`systems catalog is missing reserved-lane camera component(s): ${missing.join(",")}`);
  }
  const uids = requested.map(id => uidById.get(id)!);
  if (new Set(uids).size !== uids.length) {
    throw new Error("reserved-lane camera components do not resolve to unique system UIDs");
  }
  const tokens = uids.map(alarmCameraToken);
  if (new Set(tokens).size !== tokens.length) {
    throw new Error("reserved-lane camera UIDs collapse to the same clip token");
  }
  return uids;
}

/**
 * Validates the authoritative Connected Systems observation resource for one alarm.
 * Backslashes are normalized only for Windows bucket-provider parity; the normalized
 * key must still match OSCAR's exact generation-qualified clip layout.
 */
export function assessAlarmVideoObservation(
  value: unknown,
  expectedEventId: string,
  configuredCameraUids: readonly string[],
): AlarmVideoAssociation {
  const eventId = publicObservationId(expectedEventId, "expected public observation ID");
  const observation = record(value, "occupancy observation");
  const properties = observation.properties && typeof observation.properties === "object"
    ? record(observation.properties, "occupancy observation properties")
    : observation;
  const actualEventId = publicObservationId(
    observation.id ?? properties.id,
    "occupancy public observation ID",
  );
  if (actualEventId !== eventId) throw new Error("occupancy observation ID does not match the selected alarm UUID");

  const resultValue = properties.result ?? observation.result;
  const result = record(resultValue, "occupancy observation result");
  if (!Array.isArray(result.videoPaths)) throw new Error("occupancy result.videoPaths must be an array");

  if (configuredCameraUids.length < 1) throw new Error("the reserved lane has no configured camera UIDs");
  const cameraUids = configuredCameraUids.map((uid, index) => requiredText(uid, `camera UID ${index}`));
  if (new Set(cameraUids).size !== cameraUids.length) {
    throw new Error("the reserved lane camera UID list contains duplicates");
  }
  const uidByToken = new Map<string, string>();
  for (const uid of cameraUids) {
    const token = alarmCameraToken(uid);
    if (uidByToken.has(token)) throw new Error("configured camera UIDs collapse to the same clip token");
    uidByToken.set(token, uid);
  }

  if (result.videoPaths.length !== cameraUids.length) {
    throw new Error(
      `occupancy result.videoPaths has ${result.videoPaths.length} path(s); expected ${cameraUids.length}`,
    );
  }

  const paths = result.videoPaths.map((rawPath, index): AlarmVideoPath => {
    const path = requiredText(rawPath, `videoPaths[${index}]`).replaceAll("\\", "/");
    const segments = path.split("/");
    if (segments.length !== 4 || segments[0] !== "videos" || segments[1] !== "clips") {
      throw new Error(`videoPaths[${index}] does not match videos/clips/<camera>/<timestamp>.mp4`);
    }
    const cameraToken = segments[2] ?? "";
    const fileName = segments[3] ?? "";
    if (!CAMERA_TOKEN.test(cameraToken)) throw new Error(`videoPaths[${index}] has an invalid camera token`);
    const name = CLIP_NAME.exec(fileName);
    if (!name) {
      throw new Error(`videoPaths[${index}] does not use the generation-qualified OSCAR MP4 name`);
    }
    const cameraUid = uidByToken.get(cameraToken);
    if (!cameraUid) throw new Error(`videoPaths[${index}] camera token is not configured on the reserved lane`);
    return {
      cameraUid,
      cameraToken,
      path,
      timestamp: fileName.slice(0, fileName.lastIndexOf("-g")),
      generation: Number(name[8]),
    };
  });

  if (new Set(paths.map(({path}) => path)).size !== paths.length) {
    throw new Error("occupancy result.videoPaths contains duplicate paths");
  }
  if (new Set(paths.map(({cameraUid}) => cameraUid)).size !== cameraUids.length) {
    throw new Error("occupancy result.videoPaths does not contain exactly one path per configured camera");
  }
  return {eventId, paths};
}

/** Rejects event-ID or source-object reuse across alarms generated in one run. */
export function assertAlarmVideoAssociationUnique(
  candidate: AlarmVideoAssociation,
  existing: readonly AlarmVideoAssociation[],
): void {
  const eventId = publicObservationId(candidate.eventId, "candidate alarm public observation ID");
  const ownerByPath = new Map<string, string>();
  for (const association of existing) {
    const existingEventId = publicObservationId(
      association.eventId,
      "existing alarm public observation ID",
    );
    if (existingEventId === eventId) {
      throw new Error(`alarm event UUID ${eventId} was generated more than once`);
    }
    for (const item of association.paths) {
      const path = requiredText(item.path, `alarm ${existingEventId} video path`).replaceAll("\\", "/");
      const owner = ownerByPath.get(path);
      if (owner && owner !== existingEventId) {
        throw new Error(`video path ${path} is already shared by alarm events ${owner} and ${existingEventId}`);
      }
      ownerByPath.set(path, existingEventId);
    }
  }
  for (const item of candidate.paths) {
    const path = requiredText(item.path, `alarm ${eventId} video path`).replaceAll("\\", "/");
    const owner = ownerByPath.get(path);
    if (owner) throw new Error(`alarm event ${eventId} reuses video path ${path} from alarm event ${owner}`);
  }
}

export interface AlarmMediaForensics {
  baselineFound: boolean;
  expectedPaths: number;
  currentExpectedPaths: number;
  newFinalizedPaths: number;
  newFinalizedOrphans: number;
  newPartialArtifacts: number;
  expectedAlreadyPresentAtBaseline: number;
}

export function assessAlarmMediaForensics(value: unknown, expectedPathCount: number): AlarmMediaForensics {
  const result = record(value, "alarm-media forensics");
  const integer = (field: string): number => {
    const item = result[field];
    if (!Number.isSafeInteger(item) || Number(item) < 0) {
      throw new Error(`alarm-media forensics ${field} must be a nonnegative integer`);
    }
    return Number(item);
  };
  const assessment: AlarmMediaForensics = {
    baselineFound: result.baselineFound === true,
    expectedPaths: integer("expectedPaths"),
    currentExpectedPaths: integer("currentExpectedPaths"),
    newFinalizedPaths: integer("newFinalizedPaths"),
    newFinalizedOrphans: integer("newFinalizedOrphans"),
    newPartialArtifacts: integer("newPartialArtifacts"),
    expectedAlreadyPresentAtBaseline: integer("expectedAlreadyPresentAtBaseline"),
  };
  if (assessment.expectedPaths !== expectedPathCount) {
    throw new Error("alarm-media forensics did not evaluate the exact generated path set");
  }
  return assessment;
}

export function alarmMediaForensicsPassed(value: AlarmMediaForensics): boolean {
  return value.baselineFound && value.expectedPaths > 0 &&
    value.currentExpectedPaths === value.expectedPaths &&
    value.newFinalizedPaths === value.expectedPaths &&
    value.newFinalizedOrphans === 0 && value.newPartialArtifacts === 0 &&
    value.expectedAlreadyPresentAtBaseline === 0;
}
