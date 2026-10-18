import {createHash} from "node:crypto";
import type {StorageMetricSample} from "./types.js";

export const RETAINED_FRAME_POSITIONS = [
  "FIRST", "QUARTER", "MIDDLE", "THREE_QUARTERS", "LAST",
] as const;
export const MAX_RETAINED_MEDIA_SETS = 8;
export const MAX_RETAINED_FRAME_BYTES = 12 * 1024 * 1024;
export const MAX_RETAINED_FRAME_DIMENSION = 6000;
export const MAX_RETAINED_FRAME_PIXELS = 20_000_000;
export const MAX_RETAINED_EVENT_BYTES = 64 * 1024 * 1024;
export const MAX_RETAINED_EVENT_PIXELS = 120_000_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
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
  jpegQualities: number[];
  paths: string[];
  assets: Array<{
    path: string;
    bytes: number;
    sha256: string;
    width: number;
    height: number;
    contentType: "image/jpeg";
  }>;
  declaredBytes: number;
  declaredPixels: number;
  mediaSets: Array<{
    laneUid: string;
    cameraUid: string;
    manifestPath: string;
    sourceObjectKey: string;
    sourceState: "PRESERVED_FOR_ROLLBACK" | "ELIGIBLE_FOR_DELETION" | "DELETED";
    lifecycleState: "AVAILABLE" | "HELD";
  }>;
}

/** Strictly validates the authenticated event-scoped retained-media contract. */
export function assessRetainedMediaResponse(
  value: unknown,
  expectedEventId: string,
): RetainedMediaAssessment {
  const response = object(value, "retained-media response");
  if (response.schemaVersion !== 1) throw new Error("retained-media schemaVersion must be 1");
  if (response.eventId !== expectedEventId) throw new Error("retained-media eventId does not match");
  if (!Array.isArray(response.mediaSets) || response.mediaSets.length < 1 ||
      response.mediaSets.length > MAX_RETAINED_MEDIA_SETS) {
    throw new Error(`retained-media response must contain 1-${MAX_RETAINED_MEDIA_SETS} media sets`);
  }

  const setIds = new Set<string>();
  const cameraUidSet = new Set<string>();
  const cameraUids: string[] = [];
  const jpegQualities: number[] = [];
  const paths: string[] = [];
  const assets: RetainedMediaAssessment["assets"] = [];
  const mediaSets: RetainedMediaAssessment["mediaSets"] = [];
  let frameCount = 0;
  let declaredBytes = 0;
  let declaredPixels = 0;
  response.mediaSets.forEach((rawSet, setIndex) => {
    const mediaSet = object(rawSet, `mediaSets[${setIndex}]`);
    const manifest = object(mediaSet.manifest, `mediaSets[${setIndex}].manifest`);
    if (manifest.schemaVersion !== 1 || manifest.eventId !== expectedEventId) {
      throw new Error(`mediaSets[${setIndex}] manifest identity is invalid`);
    }
    const laneUid = text(manifest.laneUid, `mediaSets[${setIndex}].manifest.laneUid`);
    const cameraUid = text(manifest.cameraUid, `mediaSets[${setIndex}].manifest.cameraUid`);
    const mediaSetId = sha256(manifest.mediaSetId, `mediaSets[${setIndex}].manifest.mediaSetId`);
    const expectedMediaSetId = createHash("sha256")
      .update(`${expectedEventId}\0${laneUid}\0${cameraUid}`, "utf8")
      .digest("hex");
    if (mediaSetId !== expectedMediaSetId || setIds.has(mediaSetId)) {
      throw new Error(`mediaSets[${setIndex}] has an invalid or duplicate deterministic mediaSetId`);
    }
    setIds.add(mediaSetId);
    if (cameraUidSet.has(cameraUid)) {
      throw new Error(`mediaSets[${setIndex}] has an invalid or duplicate cameraUid`);
    }
    cameraUidSet.add(cameraUid);
    cameraUids.push(cameraUid);
    const cameraToken = Buffer.from(cameraUid, "utf8").toString("base64url");
    const manifestPath = text(mediaSet.manifestPath, `mediaSets[${setIndex}].manifestPath`);
    if (manifestPath !== `media/${expectedEventId}/${cameraToken}/manifest.json`) {
      throw new Error(`mediaSets[${setIndex}] manifest path does not match its cameraUid`);
    }
    jpegQualities.push(integer(
      manifest.jpegQuality,
      `mediaSets[${setIndex}].manifest.jpegQuality`,
      1,
      100,
    ));
    const source = object(manifest.source, `mediaSets[${setIndex}].manifest.source`);
    const sourceObjectKey = text(source.objectKey, `mediaSets[${setIndex}].manifest.source.objectKey`)
      .replaceAll("\\", "/");
    const sourceState = text(source.state, `mediaSets[${setIndex}].manifest.source.state`);
    if (!["PRESERVED_FOR_ROLLBACK", "ELIGIBLE_FOR_DELETION", "DELETED"].includes(sourceState)) {
      throw new Error(`mediaSets[${setIndex}] has an unsupported source state`);
    }
    const lifecycleState = text(manifest.lifecycleState, `mediaSets[${setIndex}].manifest.lifecycleState`);
    if (!["AVAILABLE", "HELD"].includes(lifecycleState)) {
      throw new Error(`mediaSets[${setIndex}] is not available to the authenticated media API`);
    }
    sha256(source.sha256, `mediaSets[${setIndex}].manifest.source.sha256`);
    integer(source.bytes, `mediaSets[${setIndex}].manifest.source.bytes`, 1);
    instant(source.rollbackDeleteAfter, `mediaSets[${setIndex}].manifest.source.rollbackDeleteAfter`);
    mediaSets.push({
      laneUid,
      cameraUid,
      manifestPath,
      sourceObjectKey,
      sourceState: sourceState as RetainedMediaAssessment["mediaSets"][number]["sourceState"],
      lifecycleState: lifecycleState as RetainedMediaAssessment["mediaSets"][number]["lifecycleState"],
    });
    if (!Array.isArray(manifest.assets) || manifest.assets.length !== 5 ||
        !Array.isArray(mediaSet.assets) || mediaSet.assets.length !== 5) {
      throw new Error(`mediaSets[${setIndex}] must contain exactly five manifest and response assets`);
    }
    const positions = new Set<string>();
    const ordinals = new Set<number>();
    const canonicalAssets = new Map<string, {
      sourceFrameOrdinal: number;
      sha256: string;
      bytes: number;
      width: number;
      height: number;
    }>();
    manifest.assets.forEach((rawAsset, assetIndex) => {
      const asset = object(rawAsset, `mediaSets[${setIndex}].manifest.assets[${assetIndex}]`);
      const position = text(asset.position, `asset ${assetIndex} position`);
      if (!RETAINED_FRAME_POSITIONS.includes(position as typeof RETAINED_FRAME_POSITIONS[number])) {
        throw new Error(`mediaSets[${setIndex}] has an unsupported frame position`);
      }
      positions.add(position);
      const sourceFrameOrdinal = integer(asset.sourceFrameOrdinal, `asset ${assetIndex} ordinal`);
      ordinals.add(sourceFrameOrdinal);
      if (asset.contentType !== "image/jpeg" || asset.state !== "PUBLISHED") {
        throw new Error(`mediaSets[${setIndex}] asset ${assetIndex} is not a published JPEG`);
      }
      const bytes = integer(asset.bytes, `asset ${assetIndex} bytes`, 1, MAX_RETAINED_FRAME_BYTES);
      const width = integer(asset.width, `asset ${assetIndex} width`, 1, MAX_RETAINED_FRAME_DIMENSION);
      const height = integer(asset.height, `asset ${assetIndex} height`, 1, MAX_RETAINED_FRAME_DIMENSION);
      const pixels = width * height;
      if (pixels > MAX_RETAINED_FRAME_PIXELS) {
        throw new Error(`mediaSets[${setIndex}] asset ${assetIndex} exceeds the decoded-pixel budget`);
      }
      const digest = sha256(asset.sha256, `asset ${assetIndex} sha256`);
      canonicalAssets.set(position, {sourceFrameOrdinal, sha256: digest, bytes, width, height});
      declaredBytes += bytes;
      declaredPixels += pixels;
    });
    if (positions.size !== 5 || ordinals.size !== 5 ||
        RETAINED_FRAME_POSITIONS.some(position => !positions.has(position))) {
      throw new Error(`mediaSets[${setIndex}] does not contain five distinct canonical frames`);
    }
    const responsePositions = new Set<string>();
    mediaSet.assets.forEach((rawAsset, assetIndex) => {
      const responseAsset = object(rawAsset, `mediaSets[${setIndex}].assets[${assetIndex}]`);
      const asset = object(responseAsset.asset, `mediaSets[${setIndex}].assets[${assetIndex}].asset`);
      const position = text(asset.position, `response asset ${assetIndex} position`);
      if (responsePositions.has(position)) {
        throw new Error(`mediaSets[${setIndex}] response assets contain a duplicate frame position`);
      }
      responsePositions.add(position);
      const canonical = canonicalAssets.get(position);
      if (!canonical || canonical.sourceFrameOrdinal !== asset.sourceFrameOrdinal ||
          canonical.sha256 !== asset.sha256 || canonical.bytes !== asset.bytes ||
          canonical.width !== asset.width || canonical.height !== asset.height ||
          asset.contentType !== "image/jpeg" || asset.state !== "PUBLISHED") {
        throw new Error(`mediaSets[${setIndex}] response asset does not match its manifest`);
      }
      const path = text(responseAsset.path, `mediaSets[${setIndex}].assets[${assetIndex}].path`);
      const expectedName = `frame-0${RETAINED_FRAME_POSITIONS.indexOf(
        position as typeof RETAINED_FRAME_POSITIONS[number],
      ) + 1}.jpg`;
      const segments = path.split("/");
      if (segments.length !== 4 || segments[0] !== "media" || segments[1] !== expectedEventId ||
          segments[2] !== cameraToken || segments[3] !== expectedName) {
        throw new Error(`mediaSets[${setIndex}] response asset path escapes the event whitelist`);
      }
      paths.push(path);
      assets.push({
        path,
        bytes: integer(asset.bytes, `response asset ${assetIndex} bytes`, 1),
        sha256: sha256(asset.sha256, `response asset ${assetIndex} sha256`),
        width: integer(asset.width, `response asset ${assetIndex} width`, 1),
        height: integer(asset.height, `response asset ${assetIndex} height`, 1),
        contentType: "image/jpeg",
      });
      frameCount++;
    });
    if (responsePositions.size !== RETAINED_FRAME_POSITIONS.length ||
        RETAINED_FRAME_POSITIONS.some(position => !responsePositions.has(position))) {
      throw new Error(`mediaSets[${setIndex}] response assets do not contain five distinct canonical frames`);
    }
  });
  if (new Set(paths).size !== paths.length) throw new Error("retained-media response has duplicate paths");
  if (declaredBytes > MAX_RETAINED_EVENT_BYTES) {
    throw new Error("retained-media response exceeds the event-wide byte budget");
  }
  if (declaredPixels > MAX_RETAINED_EVENT_PIXELS) {
    throw new Error("retained-media response exceeds the event-wide decoded-pixel budget");
  }
  return {mediaSetCount: response.mediaSets.length, frameCount, cameraUids, jpegQualities, paths, assets,
    declaredBytes, declaredPixels, mediaSets};
}

export interface BaselineJpegInfo {
  width: number;
  height: number;
  components: number;
  scans: number;
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

/**
 * Parses only the bounded structure needed by OSCAR's retained-frame contract.
 * It rejects progressive/lossless/arithmetic JPEGs, malformed segment lengths,
 * truncated entropy data, multiple scans, trailing bytes, and oversized decoded
 * dimensions. Actual codec decodability is checked separately in Chromium.
 */
export function parseBaselineJpeg(bytes: Buffer): BaselineJpegInfo {
  if (bytes.length < 12 || bytes.length > MAX_RETAINED_FRAME_BYTES) {
    throw new Error("JPEG byte length is outside the retained-frame budget");
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("JPEG has no SOI marker");

  let offset = 2;
  let frame: BaselineJpegInfo | undefined;
  let hasQuantizationTable = false;
  let hasHuffmanTable = false;
  let scans = 0;
  let foundEnd = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("JPEG marker prefix is missing");
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw new Error("JPEG ends in marker padding");
    const marker = bytes[offset] ?? 0;
    offset++;
    if (marker === 0x00) throw new Error("JPEG has stuffed data outside a scan");
    if (marker === 0xd9) {
      foundEnd = true;
      if (offset !== bytes.length) throw new Error("JPEG has trailing bytes after EOI");
      break;
    }
    if (marker === 0xd8) throw new Error("JPEG contains a nested SOI marker");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error("JPEG segment length is truncated");
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new Error("JPEG segment exceeds the bounded input");
    }
    const payloadStart = offset + 2;
    const payloadEnd = offset + segmentLength;

    if (isStartOfFrame(marker)) {
      if (marker !== 0xc0) throw new Error("JPEG is not baseline sequential DCT");
      if (frame) throw new Error("JPEG contains multiple frame headers");
      if (segmentLength < 8) throw new Error("JPEG baseline frame header is truncated");
      const precision = bytes[payloadStart] ?? 0;
      const height = bytes.readUInt16BE(payloadStart + 1);
      const width = bytes.readUInt16BE(payloadStart + 3);
      const components = bytes[payloadStart + 5] ?? 0;
      if (precision !== 8) throw new Error("JPEG baseline precision must be 8 bits");
      if (components !== 3 || segmentLength !== 8 + components * 3) {
        throw new Error("JPEG must contain one three-component baseline frame");
      }
      if (width < 1 || height < 1 || width > MAX_RETAINED_FRAME_DIMENSION ||
          height > MAX_RETAINED_FRAME_DIMENSION || width * height > MAX_RETAINED_FRAME_PIXELS) {
        throw new Error("JPEG decoded dimensions exceed the retained-frame budget");
      }
      frame = {width, height, components, scans: 0};
    } else if (marker === 0xdb) {
      hasQuantizationTable = true;
    } else if (marker === 0xc4) {
      hasHuffmanTable = true;
    } else if (marker === 0xcc) {
      throw new Error("JPEG arithmetic coding is not permitted");
    }

    offset = payloadEnd;
    if (marker !== 0xda) continue;
    scans++;
    if (scans !== 1) throw new Error("JPEG must contain exactly one baseline scan");
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      let markerOffset = offset + 1;
      while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) markerOffset++;
      if (markerOffset >= bytes.length) throw new Error("JPEG entropy data is truncated");
      const scanMarker = bytes[markerOffset] ?? 0;
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset = markerOffset + 1;
        continue;
      }
      offset = markerOffset - 1;
      break;
    }
  }
  if (!foundEnd || !frame || scans !== 1 || !hasQuantizationTable || !hasHuffmanTable) {
    throw new Error("JPEG is missing required baseline structure");
  }
  return {...frame, scans};
}

export function assessJpeg(
  bytes: Buffer,
  expectedBytes: number,
  expectedSha256: string,
  expectedWidth?: number,
  expectedHeight?: number,
): boolean {
  if (bytes.length !== expectedBytes ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256) return false;
  try {
    const parsed = parseBaselineJpeg(bytes);
    return (expectedWidth === undefined || parsed.width === expectedWidth) &&
      (expectedHeight === undefined || parsed.height === expectedHeight);
  } catch {
    return false;
  }
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
  expectedRelease: string;
  configuredRelease: string;
  templateRelease: string;
  deploymentId: string;
  storageRoots: {
    archive: StorageRootIdentity;
    backup: StorageRootIdentity;
    walArchive: StorageRootIdentity;
  };
  storageLock: {
    directory: string;
    file: string;
    stablePath: boolean;
    private: boolean;
    behaviorTested: boolean;
    concurrentRejected: boolean;
  };
  walArchive: {
    archiveMode: string;
    archiveCommandExact: boolean;
    publicationContractExact: boolean;
    helper: StorageHelperIdentity;
  };
  archiveObjectHelper: StorageHelperIdentity & {
    cliExportIntegrated: boolean;
    cliPurgeIntegrated: boolean;
  };
  restoreHelpers: {
    prepare: StorageHelperIdentity;
    mergeWal: StorageHelperIdentity;
  };
  atomicPublisher: {
    helperPath: string;
    sourceStampPath: string;
    packagedSourceSha256: string;
    deployedSourceSha256: string;
    deployedBinarySha256: string;
    regularExecutable: boolean;
    sourceStampRegular: boolean;
    behaviorTested: boolean;
    firstPublishSucceeded: boolean;
    collisionRejected: boolean;
    sourcePreserved: boolean;
    destinationPreserved: boolean;
  };
  backupIsolation: {
    appBackupRootAbsent: boolean;
    postgresBackupRootAbsent: boolean;
    isolatedBasebackupWired: boolean;
  };
  nativeRuntime: {
    entrypointPath: string;
    packagedEntrypointSha256: string;
    deployedEntrypointSha256: string;
    entrypointRegularExecutable: boolean;
    containerEntrypointExact: boolean;
    managedPropertiesAfterJavaOpts: boolean;
    tmpPath: string;
    tmpMountType: string;
    tmpReadWrite: boolean;
    tmpNoexec: boolean;
    tmpNosuid: boolean;
    tmpNodev: boolean;
    nativePath: string;
    nativeMountType: string;
    nativeReadWrite: boolean;
    nativeNoexecAbsent: boolean;
    nativeNosuid: boolean;
    nativeNodev: boolean;
    nativeDirectory: boolean;
    nativeExecutable: boolean;
    runtimeUid: number;
    runtimeGid: number;
    nativeOwnerUid: number;
    nativeOwnerGid: number;
    nativeMode: string;
    nativeSizeBytes: number;
    javaProcessCount: number;
    javaTmpPropertyCount: number;
    effectiveJavaTmp: string;
    javaCppCachePropertyCount: number;
    effectiveJavaCppCache: string;
    dataTmpPropertyCount: number;
    effectiveDataTmp: string;
  };
  appImage: StorageImageIdentity;
  postgisImage: StorageImageIdentity;
  gatewayImage: StorageImageIdentity;
  dataChecksums: string;
  pgStatStatementsInstalled: boolean;
  pgStatStatementsPreloaded: boolean;
  schemaVersion: number;
  archiveMarker: {
    present: boolean;
    exact: boolean;
    format: string;
    version: string;
    dataChecksums: string;
    initializedAt: string;
  };
  batchRewriteConfigured: boolean;
  dailyJournalConfigured: boolean;
  archiveIntervalMinutes: number | null;
  deleteHotAfterArchive: boolean | null;
  rollbackGraceDays: number | null;
  videoRetention: {
    enabled: boolean | null;
    timeToRetentionDays: number | null;
    queryPeriodMinutes: number | null;
    frameCount: number | null;
    jpegQuality: number | null;
    sourceRollbackGraceHours: number | null;
  };
}

export interface StorageRootIdentity {
  format: string;
  version: string;
  deploymentId: string;
  rootKind: string;
  adoption: string;
  claimedAt: string;
  adoptedAt: string;
  adoptedBy: string;
  markerOwner: number;
  markerGroup: number;
  markerMode: string;
  rootOwner: number;
  rootGroup: number;
  rootMode: string;
  exact: boolean;
}

export interface StorageHelperIdentity {
  helperPath: string;
  packagedSha256: string;
  deployedSha256: string;
  regularExecutable: boolean;
}

export interface StorageImageIdentity {
  reference: string;
  imageId: string;
  containerImageId: string;
  repoDigests: string[];
  versionLabel: string;
  storageProfileLabel: string;
}

function rootIdentity(value: unknown, field: string): StorageRootIdentity {
  const marker = object(value, field);
  return {
    format: text(marker.format, `${field}.format`),
    version: text(marker.version, `${field}.version`),
    deploymentId: text(marker.deploymentId, `${field}.deploymentId`),
    rootKind: text(marker.rootKind, `${field}.rootKind`),
    adoption: text(marker.adoption, `${field}.adoption`),
    claimedAt: text(marker.claimedAt, `${field}.claimedAt`),
    adoptedAt: text(marker.adoptedAt, `${field}.adoptedAt`),
    adoptedBy: text(marker.adoptedBy, `${field}.adoptedBy`),
    markerOwner: integer(marker.markerOwner, `${field}.markerOwner`),
    markerGroup: integer(marker.markerGroup, `${field}.markerGroup`),
    markerMode: text(marker.markerMode, `${field}.markerMode`),
    rootOwner: integer(marker.rootOwner, `${field}.rootOwner`),
    rootGroup: integer(marker.rootGroup, `${field}.rootGroup`),
    rootMode: text(marker.rootMode, `${field}.rootMode`),
    exact: marker.exact === true,
  };
}

function helperIdentity(value: unknown, field: string): StorageHelperIdentity {
  const helper = object(value, field);
  return {
    helperPath: text(helper.helperPath, `${field}.helperPath`),
    packagedSha256: sha256(helper.packagedSha256, `${field}.packagedSha256`),
    deployedSha256: sha256(helper.deployedSha256, `${field}.deployedSha256`),
    regularExecutable: helper.regularExecutable === true,
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

function imageIdentity(value: unknown, field: string): StorageImageIdentity {
  const image = object(value, field);
  const imageId = text(image.imageId, `${field}.imageId`);
  const containerImageId = text(image.containerImageId, `${field}.containerImageId`);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId) || !/^sha256:[0-9a-f]{64}$/.test(containerImageId)) {
    throw new Error(`${field} image IDs must be immutable SHA-256 identities`);
  }
  const repoDigests = stringArray(image.repoDigests, `${field}.repoDigests`);
  if (repoDigests.some(digest => !/^[A-Za-z0-9._/:@+-]+@sha256:[0-9a-f]{64}$/.test(digest))) {
    throw new Error(`${field}.repoDigests contains a non-immutable digest`);
  }
  return {
    reference: text(image.reference, `${field}.reference`),
    imageId,
    containerImageId,
    repoDigests,
    versionLabel: typeof image.versionLabel === "string" ? image.versionLabel : "",
    storageProfileLabel: typeof image.storageProfileLabel === "string" ? image.storageProfileLabel : "",
  };
}

export function assessStoragePlatform(value: unknown): StoragePlatformProbe {
  const probe = object(value, "storage platform probe");
  const roots = object(probe.storageRoots, "storageRoots");
  const lock = object(probe.storageLock, "storageLock");
  const wal = object(probe.walArchive, "walArchive");
  return {
    expectedRelease: text(probe.expectedRelease, "expectedRelease"),
    configuredRelease: text(probe.configuredRelease, "configuredRelease"),
    templateRelease: text(probe.templateRelease, "templateRelease"),
    deploymentId: text(probe.deploymentId, "deploymentId"),
    storageRoots: {
      archive: rootIdentity(roots.archive, "storageRoots.archive"),
      backup: rootIdentity(roots.backup, "storageRoots.backup"),
      walArchive: rootIdentity(roots.walArchive, "storageRoots.walArchive"),
    },
    storageLock: {
      directory: text(lock.directory, "storageLock.directory"),
      file: text(lock.file, "storageLock.file"),
      stablePath: lock.stablePath === true,
      private: lock.private === true,
      behaviorTested: lock.behaviorTested === true,
      concurrentRejected: lock.concurrentRejected === true,
    },
    walArchive: {
      archiveMode: text(wal.archiveMode, "walArchive.archiveMode"),
      archiveCommandExact: wal.archiveCommandExact === true,
      publicationContractExact: wal.publicationContractExact === true,
      helper: helperIdentity(wal, "walArchive"),
    },
    archiveObjectHelper: (() => {
      const helper = object(probe.archiveObjectHelper, "archiveObjectHelper");
      return {
        ...helperIdentity(helper, "archiveObjectHelper"),
        cliExportIntegrated: helper.cliExportIntegrated === true,
        cliPurgeIntegrated: helper.cliPurgeIntegrated === true,
      };
    })(),
    restoreHelpers: (() => {
      const helpers = object(probe.restoreHelpers, "restoreHelpers");
      return {
        prepare: helperIdentity(helpers.prepare, "restoreHelpers.prepare"),
        mergeWal: helperIdentity(helpers.mergeWal, "restoreHelpers.mergeWal"),
      };
    })(),
    atomicPublisher: (() => {
      const publisher = object(probe.atomicPublisher, "atomicPublisher");
      return {
        helperPath: text(publisher.helperPath, "atomicPublisher.helperPath"),
        sourceStampPath: text(publisher.sourceStampPath, "atomicPublisher.sourceStampPath"),
        packagedSourceSha256: sha256(
          publisher.packagedSourceSha256,
          "atomicPublisher.packagedSourceSha256",
        ),
        deployedSourceSha256: sha256(
          publisher.deployedSourceSha256,
          "atomicPublisher.deployedSourceSha256",
        ),
        deployedBinarySha256: sha256(
          publisher.deployedBinarySha256,
          "atomicPublisher.deployedBinarySha256",
        ),
        regularExecutable: publisher.regularExecutable === true,
        sourceStampRegular: publisher.sourceStampRegular === true,
        behaviorTested: publisher.behaviorTested === true,
        firstPublishSucceeded: publisher.firstPublishSucceeded === true,
        collisionRejected: publisher.collisionRejected === true,
        sourcePreserved: publisher.sourcePreserved === true,
        destinationPreserved: publisher.destinationPreserved === true,
      };
    })(),
    backupIsolation: (() => {
      const isolation = object(probe.backupIsolation, "backupIsolation");
      return {
        appBackupRootAbsent: isolation.appBackupRootAbsent === true,
        postgresBackupRootAbsent: isolation.postgresBackupRootAbsent === true,
        isolatedBasebackupWired: isolation.isolatedBasebackupWired === true,
      };
    })(),
    nativeRuntime: (() => {
      const runtime = object(probe.nativeRuntime, "nativeRuntime");
      return {
        entrypointPath: text(runtime.entrypointPath, "nativeRuntime.entrypointPath"),
        packagedEntrypointSha256: sha256(
          runtime.packagedEntrypointSha256,
          "nativeRuntime.packagedEntrypointSha256",
        ),
        deployedEntrypointSha256: sha256(
          runtime.deployedEntrypointSha256,
          "nativeRuntime.deployedEntrypointSha256",
        ),
        entrypointRegularExecutable: runtime.entrypointRegularExecutable === true,
        containerEntrypointExact: runtime.containerEntrypointExact === true,
        managedPropertiesAfterJavaOpts: runtime.managedPropertiesAfterJavaOpts === true,
        tmpPath: text(runtime.tmpPath, "nativeRuntime.tmpPath"),
        tmpMountType: text(runtime.tmpMountType, "nativeRuntime.tmpMountType"),
        tmpReadWrite: runtime.tmpReadWrite === true,
        tmpNoexec: runtime.tmpNoexec === true,
        tmpNosuid: runtime.tmpNosuid === true,
        tmpNodev: runtime.tmpNodev === true,
        nativePath: text(runtime.nativePath, "nativeRuntime.nativePath"),
        nativeMountType: text(runtime.nativeMountType, "nativeRuntime.nativeMountType"),
        nativeReadWrite: runtime.nativeReadWrite === true,
        nativeNoexecAbsent: runtime.nativeNoexecAbsent === true,
        nativeNosuid: runtime.nativeNosuid === true,
        nativeNodev: runtime.nativeNodev === true,
        nativeDirectory: runtime.nativeDirectory === true,
        nativeExecutable: runtime.nativeExecutable === true,
        runtimeUid: integer(runtime.runtimeUid, "nativeRuntime.runtimeUid"),
        runtimeGid: integer(runtime.runtimeGid, "nativeRuntime.runtimeGid"),
        nativeOwnerUid: integer(runtime.nativeOwnerUid, "nativeRuntime.nativeOwnerUid"),
        nativeOwnerGid: integer(runtime.nativeOwnerGid, "nativeRuntime.nativeOwnerGid"),
        nativeMode: text(runtime.nativeMode, "nativeRuntime.nativeMode"),
        nativeSizeBytes: integer(runtime.nativeSizeBytes, "nativeRuntime.nativeSizeBytes"),
        javaProcessCount: integer(runtime.javaProcessCount, "nativeRuntime.javaProcessCount"),
        javaTmpPropertyCount: integer(
          runtime.javaTmpPropertyCount,
          "nativeRuntime.javaTmpPropertyCount",
        ),
        effectiveJavaTmp: text(runtime.effectiveJavaTmp, "nativeRuntime.effectiveJavaTmp"),
        javaCppCachePropertyCount: integer(
          runtime.javaCppCachePropertyCount,
          "nativeRuntime.javaCppCachePropertyCount",
        ),
        effectiveJavaCppCache: text(
          runtime.effectiveJavaCppCache,
          "nativeRuntime.effectiveJavaCppCache",
        ),
        dataTmpPropertyCount: integer(
          runtime.dataTmpPropertyCount,
          "nativeRuntime.dataTmpPropertyCount",
        ),
        effectiveDataTmp: text(runtime.effectiveDataTmp, "nativeRuntime.effectiveDataTmp"),
      };
    })(),
    appImage: imageIdentity(probe.appImage, "appImage"),
    postgisImage: imageIdentity(probe.postgisImage, "postgisImage"),
    gatewayImage: imageIdentity(probe.gatewayImage, "gatewayImage"),
    dataChecksums: text(probe.dataChecksums, "dataChecksums"),
    pgStatStatementsInstalled: probe.pgStatStatementsInstalled === true,
    pgStatStatementsPreloaded: probe.pgStatStatementsPreloaded === true,
    schemaVersion: integer(probe.schemaVersion, "schemaVersion"),
    archiveMarker: (() => {
      const marker = object(probe.archiveMarker, "archiveMarker");
      return {
        present: marker.present === true,
        exact: marker.exact === true,
        format: typeof marker.format === "string" ? marker.format : "",
        version: typeof marker.version === "string" ? marker.version : "",
        dataChecksums: typeof marker.dataChecksums === "string" ? marker.dataChecksums : "",
        initializedAt: typeof marker.initializedAt === "string" ? marker.initializedAt : "",
      };
    })(),
    batchRewriteConfigured: probe.batchRewriteConfigured === true,
    dailyJournalConfigured: probe.dailyJournalConfigured === true,
    archiveIntervalMinutes: nullableNumber(probe.archiveIntervalMinutes),
    deleteHotAfterArchive: typeof probe.deleteHotAfterArchive === "boolean"
      ? probe.deleteHotAfterArchive : null,
    rollbackGraceDays: nullableNumber(probe.rollbackGraceDays),
    videoRetention: (() => {
      const retention = object(probe.videoRetention, "videoRetention");
      return {
        enabled: typeof retention.enabled === "boolean" ? retention.enabled : null,
        timeToRetentionDays: nullableNumber(retention.timeToRetentionDays),
        queryPeriodMinutes: nullableNumber(retention.queryPeriodMinutes),
        frameCount: nullableNumber(retention.frameCount),
        jpegQuality: nullableNumber(retention.jpegQuality),
        sourceRollbackGraceHours: nullableNumber(retention.sourceRollbackGraceHours),
      };
    })(),
  };
}

export function storagePlatformHasExactReleaseIdentity(
  value: StoragePlatformProbe,
  release: string,
): boolean {
  const deploymentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const roots: Array<[StorageRootIdentity, string, number, string]> = [
    [value.storageRoots.archive, "archive", 10001, "1770"],
    [value.storageRoots.backup, "backup", 0, "700"],
    [value.storageRoots.walArchive, "wal-archive", 999, "1770"],
  ];
  const rootsExact = roots.every(([root, kind, group, mode]) => root.exact &&
    root.format === "oscar-storage-root-identity" && root.version === "1" &&
    root.deploymentId === value.deploymentId && root.rootKind === kind &&
    ["new", "explicit-existing"].includes(root.adoption) &&
    Number.isFinite(Date.parse(root.claimedAt)) &&
    ((root.adoption === "new" && root.adoptedAt === "none" && root.adoptedBy === "none") ||
      (root.adoption === "explicit-existing" && Number.isFinite(Date.parse(root.adoptedAt)) &&
        root.adoptedBy !== "none")) &&
    root.markerOwner === 0 && root.markerGroup === 0 && root.markerMode === "600" &&
    root.rootOwner === 0 && root.rootGroup === group && root.rootMode === mode);
  const helperExact = (helper: StorageHelperIdentity, path: string) =>
    helper.helperPath === path && helper.regularExecutable &&
    helper.packagedSha256 === helper.deployedSha256;
  return value.expectedRelease === release &&
    value.configuredRelease === release &&
    value.templateRelease === release &&
    deploymentPattern.test(value.deploymentId) &&
    rootsExact &&
    value.storageLock.file === `${value.storageLock.directory}/${value.deploymentId}.lock` &&
    value.storageLock.stablePath && value.storageLock.private &&
    value.storageLock.behaviorTested && value.storageLock.concurrentRejected &&
    value.walArchive.archiveMode === "on" && value.walArchive.archiveCommandExact &&
    value.walArchive.publicationContractExact &&
    helperExact(value.walArchive.helper, "/usr/local/bin/oscar-archive-wal") &&
    helperExact(value.archiveObjectHelper, "/usr/local/bin/oscar-archive-object") &&
    value.archiveObjectHelper.cliExportIntegrated && value.archiveObjectHelper.cliPurgeIntegrated &&
    helperExact(value.restoreHelpers.prepare, "/usr/local/bin/oscar-prepare-restore") &&
    helperExact(value.restoreHelpers.mergeWal, "/usr/local/bin/oscar-merge-wal-restore") &&
    value.atomicPublisher.helperPath === "/usr/local/bin/oscar-atomic-publish" &&
    value.atomicPublisher.sourceStampPath ===
      "/usr/local/share/oscar-atomic-publish.source.sha256" &&
    value.atomicPublisher.packagedSourceSha256 === value.atomicPublisher.deployedSourceSha256 &&
    value.atomicPublisher.regularExecutable && value.atomicPublisher.sourceStampRegular &&
    value.atomicPublisher.behaviorTested && value.atomicPublisher.firstPublishSucceeded &&
    value.atomicPublisher.collisionRejected && value.atomicPublisher.sourcePreserved &&
    value.atomicPublisher.destinationPreserved &&
    value.backupIsolation.appBackupRootAbsent &&
    value.backupIsolation.postgresBackupRootAbsent &&
    value.backupIsolation.isolatedBasebackupWired &&
    value.nativeRuntime.entrypointPath === "/usr/local/bin/oscar-entrypoint" &&
    value.nativeRuntime.packagedEntrypointSha256 ===
      value.nativeRuntime.deployedEntrypointSha256 &&
    value.nativeRuntime.entrypointRegularExecutable &&
    value.nativeRuntime.containerEntrypointExact &&
    value.nativeRuntime.managedPropertiesAfterJavaOpts &&
    value.nativeRuntime.tmpPath === "/tmp" &&
    value.nativeRuntime.tmpMountType === "tmpfs" &&
    value.nativeRuntime.tmpReadWrite && value.nativeRuntime.tmpNoexec &&
    value.nativeRuntime.tmpNosuid && value.nativeRuntime.tmpNodev &&
    value.nativeRuntime.nativePath === "/run/oscar-native" &&
    value.nativeRuntime.nativeMountType === "tmpfs" &&
    value.nativeRuntime.nativeReadWrite && value.nativeRuntime.nativeNoexecAbsent &&
    value.nativeRuntime.nativeNosuid && value.nativeRuntime.nativeNodev &&
    value.nativeRuntime.nativeDirectory && value.nativeRuntime.nativeExecutable &&
    value.nativeRuntime.runtimeUid === 10001 && value.nativeRuntime.runtimeGid === 10001 &&
    value.nativeRuntime.nativeOwnerUid === 10001 &&
    value.nativeRuntime.nativeOwnerGid === 10001 &&
    value.nativeRuntime.nativeMode === "700" &&
    value.nativeRuntime.nativeSizeBytes === 256 * 1024 * 1024 &&
    value.nativeRuntime.javaProcessCount === 1 &&
    value.nativeRuntime.javaTmpPropertyCount >= 1 &&
    value.nativeRuntime.effectiveJavaTmp === "/run/oscar-native" &&
    value.nativeRuntime.javaCppCachePropertyCount >= 1 &&
    value.nativeRuntime.effectiveJavaCppCache === "/run/oscar-native/javacpp" &&
    value.nativeRuntime.dataTmpPropertyCount >= 1 &&
    value.nativeRuntime.effectiveDataTmp === "/tmp" &&
    value.appImage.reference === `oscar:${release}` &&
    value.postgisImage.reference === `oscar-postgis:${release}` &&
    value.gatewayImage.reference === "nginxinc/nginx-unprivileged:1.28.1-alpine" &&
    value.appImage.imageId === value.appImage.containerImageId &&
    value.postgisImage.imageId === value.postgisImage.containerImageId &&
    value.gatewayImage.imageId === value.gatewayImage.containerImageId &&
    value.appImage.versionLabel === release &&
    value.postgisImage.versionLabel === release &&
    value.postgisImage.storageProfileLabel === release &&
    value.archiveMarker.present &&
    value.archiveMarker.exact &&
    value.archiveMarker.format === "oscar-storage-profile" &&
    value.archiveMarker.version === release &&
    value.archiveMarker.dataChecksums === "on" &&
    Number.isFinite(Date.parse(value.archiveMarker.initializedAt));
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
  archivePartialArtifacts: number;
  walPartialArtifacts: number;
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
    archivePartialArtifacts: integer(probe.archivePartialArtifacts, "archivePartialArtifacts"),
    walPartialArtifacts: integer(probe.walPartialArtifacts, "walPartialArtifacts"),
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
