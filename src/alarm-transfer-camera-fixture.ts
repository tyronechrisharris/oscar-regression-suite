import {createHash} from "node:crypto";
import {deflateSync, inflateSync} from "node:zlib";
import QRCode from "qrcode";

const ALARM_QR_PREFIX = "OSCAR-ALARM:1:";
const BASE45_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const CAMERA_FIXTURE_OBSERVATION_ID = "00000000-0000-4000-8000-000000000050";
const CAMERA_FIXTURE_OCCUPANCY_ID = "camera-regression-50";
const CAMERA_FIXTURE_LANE_ID = "CameraFixtureLane";
const CAMERA_FRAME_WIDTH = 640;
const CAMERA_FRAME_HEIGHT = 480;
const QR_QUIET_ZONE_MODULES = 4;
const QR_PIXELS_PER_MODULE = 3;

interface CompactAlarmSeries {
  originalCount: number;
  exportedCount: number;
  points?: [number, number][];
  constant?: number;
  unit: "cps";
  downsampled: boolean;
}

export interface AlarmTransferCameraPayload {
  schema: "org.oscar.alarm-transfer";
  version: 1;
  exportedAt: string;
  exportProfile: "qr-downsampled";
  source: {
    nodeId: string;
    nodeName: string;
    laneId: string;
  };
  event: {
    occupancyId: string;
    observationId: string;
    startTime: string;
    endTime: string;
    status: string;
    maxGamma: number;
    maxNeutron: number;
  };
  series: {
    timeOrigin: string;
    gamma: CompactAlarmSeries;
    neutron: CompactAlarmSeries;
    threshold: CompactAlarmSeries;
    fullResolutionSha256: string;
  };
  authenticity: {
    signed: false;
    notice: "integrity-only";
  };
}

export interface AlarmTransferCameraFixture {
  observationId: string;
  occupancyId: string;
  laneId: string;
  transport: string;
  digest: string;
  transportCharacters: number;
  qrVersion: number;
  qrSize: number;
  qrModules: number[];
  frameWidth: number;
  frameHeight: number;
  quietZoneModules: number;
  pixelsPerModule: number;
  symbolPixels: number;
}

export interface AlarmTransferCameraState {
  requestCount: number;
  rejectedRequestCount: number;
  createdTrackCount: number;
  stoppedTrackCount: number;
  activeTrackCount: number;
  previewFrameRendered: boolean;
  qrFrameRendered: boolean;
  requestedFrameCount: number;
  lastConstraints: unknown;
}

function base45Encode(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 2) {
    if (index + 1 < bytes.length) {
      let value = (bytes[index] ?? 0) * 256 + (bytes[index + 1] ?? 0);
      const first = value % 45;
      value = Math.floor(value / 45);
      const second = value % 45;
      const third = Math.floor(value / 45);
      output += BASE45_ALPHABET.charAt(first) + BASE45_ALPHABET.charAt(second) +
        BASE45_ALPHABET.charAt(third);
    } else {
      const value = bytes[index] ?? 0;
      output += BASE45_ALPHABET.charAt(value % 45) +
        BASE45_ALPHABET.charAt(Math.floor(value / 45));
    }
  }
  return output;
}

function base45Decode(value: string): Uint8Array {
  if (value.length % 3 === 1) throw new Error("Invalid Base45 length");
  const output: number[] = [];
  for (let index = 0; index < value.length;) {
    const groupLength = value.length - index >= 3 ? 3 : 2;
    const first = BASE45_ALPHABET.indexOf(value[index] ?? "");
    const second = BASE45_ALPHABET.indexOf(value[index + 1] ?? "");
    if (first < 0 || second < 0) throw new Error("Invalid Base45 character");
    let decoded = first + second * 45;
    if (groupLength === 3) {
      const third = BASE45_ALPHABET.indexOf(value[index + 2] ?? "");
      if (third < 0) throw new Error("Invalid Base45 character");
      decoded += third * 45 * 45;
      if (decoded > 0xffff) throw new Error("Invalid Base45 value");
      output.push(Math.floor(decoded / 256), decoded % 256);
    } else {
      if (decoded > 0xff) throw new Error("Invalid Base45 value");
      output.push(decoded);
    }
    index += groupLength;
  }
  return Uint8Array.from(output);
}

function deterministicSeries(count: number, seed: number, baseline: number, spread: number): [number, number][] {
  let state = seed >>> 0;
  return Array.from({length: count}, (_, index) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const value = Math.round((baseline + (state % (spread * 1_000)) / 1_000) * 1_000) / 1_000;
    return [index * 137 + (state % 97), value];
  });
}

function fixturePayload(): AlarmTransferCameraPayload {
  const startTime = "2026-01-01T12:00:00.000Z";
  const gamma = deterministicSeries(20, 0x0a51ca7e, 2, 30);
  const neutron = deterministicSeries(10, 0x0b51ca7e, 1, 5);
  const threshold = deterministicSeries(10, 0x0c51ca7e, 8, 6);
  return {
    schema: "org.oscar.alarm-transfer",
    version: 1,
    exportedAt: "2026-01-01T12:01:00.000Z",
    exportProfile: "qr-downsampled",
    source: {
      nodeId: "camera-regression-node",
      nodeName: "Camera Regression Fixture",
      laneId: CAMERA_FIXTURE_LANE_ID,
    },
    event: {
      occupancyId: CAMERA_FIXTURE_OCCUPANCY_ID,
      observationId: CAMERA_FIXTURE_OBSERVATION_ID,
      startTime,
      endTime: "2026-01-01T12:00:02.000Z",
      status: "Gamma Alarm",
      maxGamma: 18,
      maxNeutron: 2,
    },
    series: {
      timeOrigin: startTime,
      gamma: {
        originalCount: gamma.length,
        exportedCount: gamma.length,
        points: gamma,
        unit: "cps",
        downsampled: false,
      },
      neutron: {
        originalCount: neutron.length,
        exportedCount: neutron.length,
        points: neutron,
        unit: "cps",
        downsampled: false,
      },
      threshold: {
        originalCount: threshold.length,
        exportedCount: threshold.length,
        points: threshold,
        unit: "cps",
        downsampled: false,
      },
      fullResolutionSha256: createHash("sha256").update("oscar-camera-fixture-series").digest("hex"),
    },
    authenticity: {signed: false, notice: "integrity-only"},
  };
}

export function createAlarmTransferCameraFixture(): AlarmTransferCameraFixture {
  const payload = fixturePayload();
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const digest = createHash("sha256").update(json).digest("hex");
  const compressed = deflateSync(json, {level: 9});
  const transport = `${ALARM_QR_PREFIX}${base45Encode(compressed)}/${digest.toUpperCase()}`;
  if (transport.length > 2_200) {
    throw new Error(`Alarm Transfer camera fixture exceeds the QR limit (${transport.length} characters)`);
  }
  if (transport.length < 1_100 || transport.length > 1_300) {
    throw new Error(`Alarm Transfer camera fixture is not representative (${transport.length} characters)`);
  }

  const qr = QRCode.create(transport, {version: 23, errorCorrectionLevel: "M"});
  if (qr.version !== 23 || qr.modules.size !== 109) {
    throw new Error(`Alarm Transfer camera fixture expected QR version 23; got ${qr.version}`);
  }
  const qrModules: number[] = [];
  for (let row = 0; row < qr.modules.size; row++) {
    for (let column = 0; column < qr.modules.size; column++) {
      qrModules.push(qr.modules.get(row, column) ? 1 : 0);
    }
  }
  return {
    observationId: payload.event.observationId,
    occupancyId: payload.event.occupancyId,
    laneId: payload.source.laneId,
    transport,
    digest,
    transportCharacters: transport.length,
    qrVersion: qr.version,
    qrSize: qr.modules.size,
    qrModules,
    frameWidth: CAMERA_FRAME_WIDTH,
    frameHeight: CAMERA_FRAME_HEIGHT,
    quietZoneModules: QR_QUIET_ZONE_MODULES,
    pixelsPerModule: QR_PIXELS_PER_MODULE,
    symbolPixels: (qr.modules.size + QR_QUIET_ZONE_MODULES * 2) * QR_PIXELS_PER_MODULE,
  };
}

export function decodeAlarmTransferCameraTransport(transport: string): AlarmTransferCameraPayload {
  const trimmed = transport.trim();
  if (!trimmed.startsWith(ALARM_QR_PREFIX)) throw new Error("Not an OSCAR alarm QR transport");
  const separator = trimmed.lastIndexOf("/");
  if (separator <= ALARM_QR_PREFIX.length) throw new Error("Alarm QR integrity value is missing");
  const expectedDigest = trimmed.slice(separator + 1).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new Error("Alarm QR integrity value is invalid");
  const json = inflateSync(base45Decode(trimmed.slice(ALARM_QR_PREFIX.length, separator)));
  const actualDigest = createHash("sha256").update(json).digest("hex");
  if (actualDigest !== expectedDigest) throw new Error("Alarm QR integrity check failed");
  return JSON.parse(json.toString("utf8")) as AlarmTransferCameraPayload;
}
