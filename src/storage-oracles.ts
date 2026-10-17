import {createHash} from "node:crypto";
import type {StorageMetricSample} from "./types.js";

export const RETAINED_FRAME_POSITIONS = [
  "FIRST", "QUARTER", "MIDDLE", "THREE_QUARTERS", "LAST",
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be text`);
  return value;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${field} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function sha256(value: unknown, field: string): string {
  const result = text(value, field);
  if (!SHA256_PATTERN.test(result)) throw new Error(`${field} must be a lowercase SHA-256`);
  return result;
}

function instant(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${field} must be an ISO timestamp`);
  return result;
}

export interface RetainedMediaAssessment {
  mediaSetCount: number;
  frameCount: number;
  cameraUids: string[];
  paths: string[];
  assets: Array<{path: string; bytes: number; sha256: string}>;
}

/** Strictly validates the authenticated event-scoped retained-media contract. */
export function assessRetainedMediaResponse(
  value: unknown,
  expectedEventId: string,
): RetainedMediaAssessment {
  const response = object(value, "retained-media response");
  if (response.schemaVersion !== 1) throw new Error("retained-media schemaVersion must be 1");
  if (response.eventId !== expectedEventId) throw new Error("retained-media eventId does not match");
  if (!Array.isArray(response.mediaSets) || response.mediaSets.length < 1 || response.mediaSets.length > 32) {
    throw new Error("retained-media response must contain 1-32 media sets");
  }

  const setIds = new Set<string>();
  const cameraUids: string[] = [];
  const paths: string[] = [];
  const assets: Array<{path: string; bytes: number; sha256: string}> = [];
  let frameCount = 0;
  response.mediaSets.forEach((rawSet, setIndex) => {
    const mediaSet = object(rawSet, `mediaSets[${setIndex}]`);
    const manifest = object(mediaSet.manifest, `mediaSets[${setIndex}].manifest`);
    if (manifest.schemaVersion !== 1 || manifest.eventId !== expectedEventId) {
      throw new Error(`mediaSets[${setIndex}] manifest identity is invalid`);
    }
    const mediaSetId = text(manifest.mediaSetId, `mediaSets[${setIndex}].manifest.mediaSetId`);
    if (!UUID_PATTERN.test(mediaSetId) || setIds.has(mediaSetId)) {
      throw new Error(`mediaSets[${setIndex}] has an invalid or duplicate mediaSetId`);
    }
    setIds.add(mediaSetId);
    const cameraUid = text(manifest.cameraUid, `mediaSets[${setIndex}].manifest.cameraUid`);
    cameraUids.push(cameraUid);
    integer(manifest.jpegQuality, `mediaSets[${setIndex}].manifest.jpegQuality`, 1);
    const source = object(manifest.source, `mediaSets[${setIndex}].manifest.source`);
    sha256(source.sha256, `mediaSets[${setIndex}].manifest.source.sha256`);
    integer(source.bytes, `mediaSets[${setIndex}].manifest.source.bytes`, 1);
    instant(source.rollbackDeleteAfter, `mediaSets[${setIndex}].manifest.source.rollbackDeleteAfter`);
    if (!Array.isArray(manifest.assets) || manifest.assets.length !== 5 ||
        !Array.isArray(mediaSet.assets) || mediaSet.assets.length !== 5) {
      throw new Error(`mediaSets[${setIndex}] must contain exactly five manifest and response assets`);
    }
    const positions = new Set<string>();
    const ordinals = new Set<number>();
    const assetHashes = new Map<string, string>();
    manifest.assets.forEach((rawAsset, assetIndex) => {
      const asset = object(rawAsset, `mediaSets[${setIndex}].manifest.assets[${assetIndex}]`);
      const position = text(asset.position, `asset ${assetIndex} position`);
      if (!RETAINED_FRAME_POSITIONS.includes(position as typeof RETAINED_FRAME_POSITIONS[number])) {
        throw new Error(`mediaSets[${setIndex}] has an unsupported frame position`);
      }
      positions.add(position);
      ordinals.add(integer(asset.sourceFrameOrdinal, `asset ${assetIndex} ordinal`));
      if (asset.contentType !== "image/jpeg" || asset.state !== "PUBLISHED") {
        throw new Error(`mediaSets[${setIndex}] asset ${assetIndex} is not a published JPEG`);
      }
      integer(asset.bytes, `asset ${assetIndex} bytes`, 1);
      integer(asset.width, `asset ${assetIndex} width`, 1);
      integer(asset.height, `asset ${assetIndex} height`, 1);
      const digest = sha256(asset.sha256, `asset ${assetIndex} sha256`);
      assetHashes.set(position, digest);
    });
    if (positions.size !== 5 || ordinals.size !== 5 ||
        RETAINED_FRAME_POSITIONS.some(position => !positions.has(position))) {
      throw new Error(`mediaSets[${setIndex}] does not contain five distinct canonical frames`);
    }
    mediaSet.assets.forEach((rawAsset, assetIndex) => {
      const responseAsset = object(rawAsset, `mediaSets[${setIndex}].assets[${assetIndex}]`);
      const asset = object(responseAsset.asset, `mediaSets[${setIndex}].assets[${assetIndex}].asset`);
      const position = text(asset.position, `response asset ${assetIndex} position`);
      if (assetHashes.get(position) !== asset.sha256) {
        throw new Error(`mediaSets[${setIndex}] response asset does not match its manifest`);
      }
      const path = text(responseAsset.path, `mediaSets[${setIndex}].assets[${assetIndex}].path`);
      const expectedName = `frame-0${RETAINED_FRAME_POSITIONS.indexOf(
        position as typeof RETAINED_FRAME_POSITIONS[number],
      ) + 1}.jpg`;
      const segments = path.split("/");
      if (segments.length !== 4 || segments[0] !== "media" || segments[1] !== expectedEventId ||
          segments[3] !== expectedName || !/^[A-Za-z0-9._-]+$/.test(segments[2] ?? "") ||
          segments[2] === "." || segments[2] === "..") {
        throw new Error(`mediaSets[${setIndex}] response asset path escapes the event whitelist`);
      }
      paths.push(path);
      assets.push({
        path,
        bytes: integer(asset.bytes, `response asset ${assetIndex} bytes`, 1),
        sha256: sha256(asset.sha256, `response asset ${assetIndex} sha256`),
      });
      frameCount++;
    });
  });
  if (new Set(paths).size !== paths.length) throw new Error("retained-media response has duplicate paths");
  return {mediaSetCount: response.mediaSets.length, frameCount, cameraUids, paths, assets};
}

export function assessJpeg(bytes: Buffer, expectedBytes: number, expectedSha256: string): boolean {
  return bytes.length === expectedBytes && bytes.length > 4 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 &&
    createHash("sha256").update(bytes).digest("hex") === expectedSha256;
}

export interface DailyFileManifest {
  schemaVersion: number;
  laneId: string;
  windowStartInclusive: string;
  windowEndExclusive: string;
  dataFile: string;
  recordCount: number;
  byteCount: number;
  sha256: string;
}

export function assessDailyFilePublication(
  manifestValue: unknown,
  csv: Buffer,
  expectedLaneId?: string,
): DailyFileManifest {
  const manifest = object(manifestValue, "daily-file manifest");
  const result: DailyFileManifest = {
    schemaVersion: integer(manifest.schemaVersion, "schemaVersion", 1),
    laneId: text(manifest.laneId, "laneId"),
    windowStartInclusive: instant(manifest.windowStartInclusive, "windowStartInclusive"),
    windowEndExclusive: instant(manifest.windowEndExclusive, "windowEndExclusive"),
    dataFile: text(manifest.dataFile, "dataFile"),
    recordCount: integer(manifest.recordCount, "recordCount"),
    byteCount: integer(manifest.byteCount, "byteCount"),
    sha256: sha256(manifest.sha256, "sha256"),
  };
  if (result.schemaVersion !== 1) throw new Error("daily-file schemaVersion must be 1");
  if (expectedLaneId && result.laneId !== expectedLaneId) throw new Error("daily-file laneId does not match");
  if (Date.parse(result.windowEndExclusive) <= Date.parse(result.windowStartInclusive)) {
    throw new Error("daily-file window must be non-empty");
  }
  if (result.byteCount !== csv.length || createHash("sha256").update(csv).digest("hex") !== result.sha256) {
    throw new Error("daily-file bytes do not match the manifest");
  }
  const records = csv.length === 0 ? 0 : csv.toString("utf8").split(/\r?\n/).filter(Boolean).length;
  if (records !== result.recordCount) throw new Error("daily-file record count does not match the manifest");
  return result;
}

export interface StoragePlatformProbe {
  dataChecksums: string;
  pgStatStatementsInstalled: boolean;
  pgStatStatementsPreloaded: boolean;
  schemaVersion: number;
  archiveMarkerPresent: boolean;
  batchRewriteConfigured: boolean;
  dailyJournalConfigured: boolean;
  archiveIntervalMinutes: number | null;
  deleteHotAfterArchive: boolean | null;
  rollbackGraceDays: number | null;
}

export function assessStoragePlatform(value: unknown): StoragePlatformProbe {
  const probe = object(value, "storage platform probe");
  return {
    dataChecksums: text(probe.dataChecksums, "dataChecksums"),
    pgStatStatementsInstalled: probe.pgStatStatementsInstalled === true,
    pgStatStatementsPreloaded: probe.pgStatStatementsPreloaded === true,
    schemaVersion: integer(probe.schemaVersion, "schemaVersion"),
    archiveMarkerPresent: probe.archiveMarkerPresent === true,
    batchRewriteConfigured: probe.batchRewriteConfigured === true,
    dailyJournalConfigured: probe.dailyJournalConfigured === true,
    archiveIntervalMinutes: nullableNumber(probe.archiveIntervalMinutes),
    deleteHotAfterArchive: typeof probe.deleteHotAfterArchive === "boolean"
      ? probe.deleteHotAfterArchive : null,
    rollbackGraceDays: nullableNumber(probe.rollbackGraceDays),
  };
}

export interface ArchiveHealthProbe {
  activeGenerations: number;
  sealedGenerations: number;
  archiveRows: number;
  archiveBytes: number;
  failedJobs: number;
  parityFailures: number;
  activeHolds: number;
  incompleteActiveObjects: number;
  checksumVerificationPassed: boolean;
}

export function assessArchiveHealth(value: unknown): ArchiveHealthProbe {
  const probe = object(value, "archive health probe");
  return {
    activeGenerations: integer(probe.activeGenerations, "activeGenerations"),
    sealedGenerations: integer(probe.sealedGenerations, "sealedGenerations"),
    archiveRows: integer(probe.archiveRows, "archiveRows"),
    archiveBytes: integer(probe.archiveBytes, "archiveBytes"),
    failedJobs: integer(probe.failedJobs, "failedJobs"),
    parityFailures: integer(probe.parityFailures, "parityFailures"),
    activeHolds: integer(probe.activeHolds, "activeHolds"),
    incompleteActiveObjects: integer(probe.incompleteActiveObjects, "incompleteActiveObjects"),
    checksumVerificationPassed: probe.checksumVerificationPassed === true,
  };
}

export function storageMetricFromProbe(
  phase: string,
  value: unknown,
): Omit<StorageMetricSample, "runId" | "timestamp"> {
  const probe = object(value, "storage metric probe");
  const fields = [
    "databaseSizeBytes", "observationTableBytes", "observationIndexBytes", "walBytes",
    "tempBytes", "tuplesInserted", "tuplesUpdated", "tuplesDeleted", "transactionCommits",
    "transactionRollbacks", "observationInsertCalls", "observationInsertRows",
    "observationRowsPerCall", "activeArchiveGenerations", "sealedArchiveGenerations",
    "archiveRows", "archiveBytes", "failedArchiveJobs", "failedParityReceipts", "activeHolds",
    "verifiedBackups", "journalBytes", "dailyFileBytes", "retainedMediaBytes", "backupBytes",
  ] as const;
  const numbers = Object.fromEntries(fields.map(field => [field, nullableNumber(probe[field])])) as
    Record<typeof fields[number], number | null>;
  return {phase, ...numbers, note: typeof probe.note === "string" ? probe.note : ""};
}

/** OSH public IDs are base32hex(varint(scope) + varlong(local ID)), without padding. */
export function encodeOshBigId(scope: number, localId: bigint): string {
  if (!Number.isSafeInteger(scope) || scope < 0) throw new Error("scope must be a non-negative integer");
  if (localId <= 0n || localId > 0x7fffffffffffffffn) throw new Error("local ID must be a positive signed 64-bit value");
  const bytes: number[] = [];
  const appendVarint = (input: bigint) => {
    let value = input;
    do {
      const bits = Number(value & 0x7fn);
      value >>= 7n;
      bytes.push(bits | (value === 0n ? 0 : 0x80));
    } while (value !== 0n);
  };
  appendVarint(BigInt(scope));
  appendVarint(localId);
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let accumulator = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += alphabet[(accumulator >>> bitCount) & 31];
      accumulator &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) encoded += alphabet[(accumulator << (5 - bitCount)) & 31];
  return encoded;
}

export function parseCollectionIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const id = (item as Record<string, unknown>).id;
      return typeof id === "string" ? [id] : [];
    });
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items
    : Array.isArray(record.results) ? record.results : [];
  return parseCollectionIds(items);
}
