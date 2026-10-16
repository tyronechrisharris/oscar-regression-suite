import {createHash} from "node:crypto";
import {inflateSync} from "node:zlib";
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
const CAMERA_FIXTURE_TRANSPORT_CHARACTERS = 1_170;
const CAMERA_FIXTURE_QR_VERSION = 23;
const CAMERA_FIXTURE_DIGEST = "5fb60f46505448b04d997cf3f111880a4cb4fbbbe405d3628d586721a3699840";

// Pin the complete transport rather than recompressing the payload at runtime.
// zlib output differs across supported Node versions even when the inflated JSON
// is identical, which would otherwise change the dense-QR regression oracle.
const CAMERA_FIXTURE_TRANSPORT =
  "OSCAR-ALARM:1:NCF1+JEXRL$Q+S1Q%IQBQDM4PCTR$FE59UQ4DAA:J2S/34VI%/RWLR9GJP+KP:QRAPY D760FB4R55E3U YRSP" +
  "6K1RC.TT94BYT% P0B7Q$9-J6K96 -A72IWZM%HNK/Q0QP9/6X/QEFH-.RJ8PNAL-.P+$7XGTHFKY2O+BN$*M99IGJUGNFV+FJZS" +
  "EWT1E8T:SKN7204-8FA8VYY4%Q68INSWPSY6T+DVDQI2LD6HEWS57L7*903D:JM%GM$F7CL4J3SG+P%-OV8TW BVL7PHJX FR-9D" +
  ".9B39Q39Q*ANWASX9%:C4:6Y/P.WHWTE H91I1RSDCS9:CS%FJQS0D8IKNLUO1-QO BF.OHBU6KS7/:E0-QUGRC9JOS1NSLLUFSE" +
  "AYGF-51H%70+1*$TL6I2*QV9F.O2R:HH%KO%M$JJ/TGHW4-0SBJHHXJULO$-R6SNUDUE*T:KO34JK3IHXRJFC$32E:9$-G9671VO" +
  "3A1:2MEI2C-KL6VDTBAUKDC17E0-PD9YG0RNHPTQ6B8ZI COS7P%.5-QMMODYHQ5JSSO4M64 7C O4:VCFVQG35V5GV%86C949P-" +
  "D9OIM5+MNAH7*IDOP7MHDMA$0PXV6P/S+BJ:ZU9U4HRP.UGFD82FFG3H+YFJISO227JSX85JM1-6JU+FHC4-I5N/FN85X-JYO04H" +
  "4ETN%.QNZEP:76APD31QMNEYTD-TIT8XA3X2HJ:0/RTQ3KW/5WOD9%L/1OFHS7PEU8Q:0QO11IDO40Q7*2I17O3V%7A*C24 TZGC" +
  "29GWNI176G9VWIBU8FM+N$%G%%KGUCNCC:+NZTHLFWR6RD9LU-CX9V$BWK/8JR2:F5%O5LW8ZGPC:EL05%Q7UUCGD6BSN+5RJE56" +
  "CGCE8GTIC95 B8S-8MRNPD0QXH$B4FPQK8M*OI9Z2GKIS/H ETALM.2UUAV-CD*ZVI6I/26KDHLGI%Y3K304%9EKO$.M-+4COFUT" +
  "5N1FKU97Y993QG-RC/A0+27U1KGSSTJ+4NWLTRYMMTOOIA 4TRV3Y%B*/PEW9E-QK2H %Q2ITPHH5413QH--4Q/L7KKLSLL%3 10" +
  "XQCJ4/5FB60F46505448B04D997CF3F111880A4CB4FBBBE405D3628D586721A3699840";

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
  if (digest !== CAMERA_FIXTURE_DIGEST) {
    throw new Error(`Alarm Transfer camera fixture payload changed (digest ${digest})`);
  }
  const transport = CAMERA_FIXTURE_TRANSPORT;
  if (transport.length !== CAMERA_FIXTURE_TRANSPORT_CHARACTERS) {
    throw new Error(
      `Alarm Transfer camera fixture expected ${CAMERA_FIXTURE_TRANSPORT_CHARACTERS} characters; ` +
      `got ${transport.length}`,
    );
  }
  if (!transport.endsWith(`/${digest.toUpperCase()}`)) {
    throw new Error("Alarm Transfer camera fixture digest does not match its pinned transport");
  }
  const decoded = decodeAlarmTransferCameraTransport(transport);
  if (JSON.stringify(decoded) !== json.toString("utf8")) {
    throw new Error("Alarm Transfer camera fixture payload does not match its pinned transport");
  }

  const qr = QRCode.create(transport, {version: CAMERA_FIXTURE_QR_VERSION, errorCorrectionLevel: "M"});
  if (qr.version !== CAMERA_FIXTURE_QR_VERSION || qr.modules.size !== 109) {
    throw new Error(
      `Alarm Transfer camera fixture expected QR version ${CAMERA_FIXTURE_QR_VERSION}; got ${qr.version}`,
    );
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
