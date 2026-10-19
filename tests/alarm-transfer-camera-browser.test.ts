import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createServer} from "node:http";
import {createRequire} from "node:module";
import test from "node:test";
import {chromium, type Browser, type BrowserContext} from "playwright";
import {
  createAlarmTransferCameraFixture,
  type AlarmTransferCameraFixture,
} from "../src/alarm-transfer-camera-fixture.js";
import {BrowserHarness} from "../src/browser.js";
import type {RunReporter} from "../src/reporter.js";
import type {SuiteConfig} from "../src/types.js";

interface TestableBrowserHarness {
  installAlarmTransferCamera(
    context: BrowserContext,
    fixture: AlarmTransferCameraFixture,
  ): Promise<void>;
}

interface BrowserScanner {
  start(): Promise<void>;
  destroy(): void;
}

interface BrowserProbe {
  scanner: BrowserScanner;
  decoded: Promise<string>;
  errors: string[];
}

const require = createRequire(import.meta.url);

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback scanner server did not bind a TCP port");
  return address.port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("serialized camera facade decodes its frame, denies safely, retries, and releases tracks", {
  timeout: 45_000,
}, async () => {
  const scannerFiles = new Map([
    ["/qr-scanner.umd.min.js", readFileSync(require.resolve("qr-scanner/qr-scanner.umd.min.js"))],
    ["/qr-scanner-worker.min.js", readFileSync(require.resolve("qr-scanner/qr-scanner-worker.min.js"))],
  ]);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET") {
      response.writeHead(405, {Allow: "GET"});
      response.end();
      return;
    }
    if (pathname === "/") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(
        '<main style="width:640px;height:480px"><video id="camera" muted playsinline '
        + 'style="display:block;width:640px;height:480px"></video></main>'
        + '<script src="/qr-scanner.umd.min.js"></script>',
      );
      return;
    }
    const source = scannerFiles.get(pathname);
    if (!source) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(source);
  });

  const port = await listen(server);
  let browser: Browser | undefined;
  try {
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH?.trim();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? {executablePath} : {}),
    });
    const context = await browser.newContext();
    try {
      const fixture = createAlarmTransferCameraFixture();
      const harness = new BrowserHarness(
        {} as SuiteConfig,
        {} as RunReporter,
      );
      const testableHarness = harness as unknown as TestableBrowserHarness;
      await testableHarness.installAlarmTransferCamera(context, fixture);

      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, {waitUntil: "load"});
      await harness.assertAlarmTransferCameraFacade(page);

      // Source text avoids tsx helper references leaking into the browser realm
      // when the evaluated callback contains nested functions.
      const started = await page.evaluate(`(async () => {
        const video = document.querySelector("#camera");
        if (!video) throw new Error("Camera test video is missing");
        const QrScanner = globalThis.QrScanner;
        if (!QrScanner) throw new Error("QR scanner test dependency did not load");

        let resolveDecoded;
        const decoded = new Promise((resolve) => { resolveDecoded = resolve; });
        const errors = [];
        const scanner = new QrScanner(video, (result) => resolveDecoded?.(result.data), {
          returnDetailedScanResult: true,
          calculateScanRegion: (element) => {
            const size = Math.max(1, Math.round(Math.min(element.videoWidth, element.videoHeight) * 0.875));
            return {
              x: Math.round((element.videoWidth - size) / 2),
              y: Math.round((element.videoHeight - size) / 2),
              width: size,
              height: size,
            };
          },
          maxScansPerSecond: 10,
          onDecodeError: (error) => { errors.push(String(error)); },
        });
        globalThis.__oscarCameraBrowserProbe = {scanner, decoded, errors};
        await scanner.start();

        const stream = video.srcObject;
        if (!(stream instanceof MediaStream)) throw new Error("QR scanner did not attach a media stream");
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error("QR scanner stream has no video track");
        const devices = (await navigator.mediaDevices.enumerateDevices())
          .filter((device) => device.kind === "videoinput")
          .map((device) => ({deviceId: device.deviceId, label: device.label}));
        return {
          devices,
          label: track.label,
          settings: track.getSettings(),
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          permission: (await navigator.permissions.query({name: "camera"})).state,
        };
      })()`) as {
        devices: Array<{deviceId: string; label: string}>;
        label: string;
        settings: MediaTrackSettings;
        videoWidth: number;
        videoHeight: number;
        permission: PermissionState;
      };

      assert.deepEqual(started.devices, [{
        deviceId: "oscar-alarm-transfer-camera",
        label: "OSCAR deterministic QR camera",
      }]);
      assert.equal(started.label, "OSCAR deterministic QR camera");
      assert.equal(started.settings.deviceId, "oscar-alarm-transfer-camera");
      assert.equal(started.settings.width, 640);
      assert.equal(started.settings.height, 480);
      assert.equal(started.settings.frameRate, 10);
      assert.equal(started.videoWidth, 640);
      assert.equal(started.videoHeight, 480);
      assert.equal(started.permission, "granted");

      await page.waitForTimeout(250);
      await harness.renderAlarmTransferCameraQr(page);
      const decoded = await page.evaluate(`(async () => {
        const probe = globalThis.__oscarCameraBrowserProbe;
        if (!probe) throw new Error("QR scanner browser probe is missing");
        return Promise.race([
          probe.decoded,
          new Promise((_resolve, reject) => setTimeout(
            () => reject(new Error("QR decode timed out: " + probe.errors.join(" | "))),
            10_000,
          )),
        ]);
      })()`) as string;
      assert.equal(decoded, fixture.transport);

      await page.evaluate(() => {
        const probe = (globalThis as typeof globalThis & {
          __oscarCameraBrowserProbe?: BrowserProbe;
        }).__oscarCameraBrowserProbe;
        if (!probe) throw new Error("QR scanner browser probe is missing");
        probe.scanner.destroy();
      });
      await page.waitForFunction(() => {
        const state = (globalThis as typeof globalThis & {
          __oscarAlarmTransferCamera?: {activeTrackCount: number};
        }).__oscarAlarmTransferCamera;
        return state?.activeTrackCount === 0;
      });
      const decodedState = await harness.alarmTransferCameraState(page);
      assert.equal(decodedState.qrFrameRendered, true);
      assert.ok(decodedState.requestedFrameCount > 0);
      assert.equal(decodedState.createdTrackCount, 1);
      assert.equal(decodedState.stoppedTrackCount, 1);
      assert.equal(decodedState.activeTrackCount, 0);

      await harness.rejectAlarmTransferCameraRequests(page);
      const denial = await page.evaluate(async () => {
        const permission = await navigator.permissions.query({name: "camera" as PermissionName});
        try {
          await navigator.mediaDevices.getUserMedia({video: true});
          return {permission: permission.state, rejected: false, name: "", message: ""};
        } catch (error) {
          return {
            permission: permission.state,
            rejected: true,
            name: error instanceof DOMException ? error.name : "",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      });
      assert.equal(denial.permission, "denied");
      assert.equal(denial.rejected, true);
      assert.equal(denial.name, "NotAllowedError");
      assert.match(denial.message, /permission denied/i);
      const deniedState = await harness.alarmTransferCameraState(page);
      assert.equal(deniedState.rejectedRequestCount, 1);
      assert.equal(deniedState.activeTrackCount, 0);

      await harness.allowAlarmTransferCameraRequests(page);
      const retry = await page.evaluate(async () => {
        const permission = await navigator.permissions.query({name: "camera" as PermissionName});
        const stream = await navigator.mediaDevices.getUserMedia({video: true});
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error("Retried stream has no video track");
        const result = {permission: permission.state, label: track.label, settings: track.getSettings()};
        track.stop();
        return result;
      });
      assert.equal(retry.permission, "granted");
      assert.equal(retry.label, "OSCAR deterministic QR camera");
      assert.equal(retry.settings.deviceId, "oscar-alarm-transfer-camera");
      assert.equal(retry.settings.width, 640);
      assert.equal(retry.settings.height, 480);
      const finalState = await harness.alarmTransferCameraState(page);
      assert.equal(finalState.requestCount, 3);
      assert.equal(finalState.rejectedRequestCount, 1);
      assert.equal(finalState.createdTrackCount, 2);
      assert.equal(finalState.stoppedTrackCount, 2);
      assert.equal(finalState.activeTrackCount, 0);
    } finally {
      await context.close();
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      await closeServer(server);
    }
  }
});
