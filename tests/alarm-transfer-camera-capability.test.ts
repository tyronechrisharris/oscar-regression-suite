import assert from "node:assert/strict";
import test from "node:test";
import type {Page} from "playwright";
import type {BrowserHarness} from "../src/browser.js";
import type {RpmEmulatorClient} from "../src/emulator.js";
import type {MetricsSampler} from "../src/metrics.js";
import type {RunReporter} from "../src/reporter.js";
import {RegressionScenarios} from "../src/scenarios.js";
import type {CapabilityMode, SuiteConfig} from "../src/types.js";

interface CapabilityResult {
  observed: string;
  status: string;
  evidence: string;
}

async function runCapabilityProbe(input: {
  mode: CapabilityMode;
  importUiReady: boolean;
  startControl: boolean;
  imageControl: boolean;
}): Promise<{result: CapabilityResult; screenshots: string[]}> {
  let hydrated = false;
  const screenshots: string[] = [];
  const outcomes: CapabilityResult[] = [];
  const page = {
    goto: async () => ({status: () => 200}),
    getByLabel: (label: string, options: {exact?: boolean}) => {
      assert.equal(label, "Paste OSCAR alarm QR payload");
      assert.equal(options.exact, true);
      return {
        waitFor: async () => {
          await Promise.resolve();
          if (!input.importUiReady) throw new Error("import UI did not hydrate");
          hydrated = true;
        },
      };
    },
    getByRole: (_role: string, options: {name: RegExp}) => {
      if (options.name.test("Stop camera scan")) {
        return {isVisible: async () => false, click: async () => undefined};
      }
      assert.equal(hydrated, true, "camera controls must not be inspected before import UI hydration");
      const isStartControl = options.name.test("Start camera scan");
      return {
        count: async () => (isStartControl ? input.startControl : input.imageControl) ? 1 : 0,
        isVisible: async () => false,
        click: async () => undefined,
      };
    },
    close: async () => undefined,
  } as unknown as Page;
  const reporter = {
    outcome: (...values: unknown[]) => outcomes.push({
      observed: String(values[5] ?? ""),
      status: String(values[6] ?? ""),
      evidence: String(values[8] ?? ""),
    }),
  } as unknown as RunReporter;
  const browser = {
    alarmTransferCameraFixture: () => ({}),
    oscarPage: async () => page,
    screenshot: async (_page: Page, name: string) => {
      screenshots.push(name);
      return `evidence/${name}.png`;
    },
  } as unknown as BrowserHarness;
  const scenarios = new RegressionScenarios(
    {
      alarmTransferCameraWorkflow: input.mode,
      oscarBaseUrl: "https://oscar.test",
      uiTimeoutMs: 50,
    } as SuiteConfig,
    reporter,
    browser,
    {} as RpmEmulatorClient,
    {} as MetricsSampler,
  );

  await (scenarios as unknown as {alarmTransferCamera(): Promise<void>}).alarmTransferCamera();
  assert.equal(outcomes.length, 1);
  return {result: outcomes[0] as CapabilityResult, screenshots};
}

test("camera capability detection waits for import UI hydration before preserving an auto absence skip", async () => {
  const {result, screenshots} = await runCapabilityProbe({
    mode: "auto", importUiReady: true, startControl: false, imageControl: false,
  });
  assert.equal(result.status, "skipped");
  assert.match(result.observed, /not present on this build/);
  assert.deepEqual(screenshots, []);
});

test("required camera capability reports both absent controls with screenshot evidence", async () => {
  const {result, screenshots} = await runCapabilityProbe({
    mode: "required", importUiReady: true, startControl: false, imageControl: false,
  });
  assert.equal(result.status, "incorrect");
  assert.equal(result.observed, "camera and QR-image scan controls are both absent");
  assert.equal(result.evidence, "evidence/alarm-transfer-camera-capability-missing.png");
  assert.deepEqual(screenshots, ["alarm-transfer-camera-capability-missing"]);
});

test("partial camera capability never auto-skips and records which control is absent", async () => {
  const {result, screenshots} = await runCapabilityProbe({
    mode: "auto", importUiReady: true, startControl: true, imageControl: false,
  });
  assert.equal(result.status, "incorrect");
  assert.equal(result.observed, "partial camera workflow: start control=true; QR-image control=false");
  assert.deepEqual(screenshots, ["alarm-transfer-camera-capability-missing"]);
});

test("an unhydrated Alarm Transfer import UI fails with screenshot evidence", async () => {
  const {result, screenshots} = await runCapabilityProbe({
    mode: "required", importUiReady: false, startControl: false, imageControl: false,
  });
  assert.equal(result.status, "incorrect");
  assert.match(result.observed, /import UI did not become ready/);
  assert.equal(result.evidence, "evidence/alarm-transfer-camera-import-ui-not-ready.png");
  assert.deepEqual(screenshots, ["alarm-transfer-camera-import-ui-not-ready"]);
});
