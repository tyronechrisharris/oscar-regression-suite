import {readFileSync, writeFileSync} from "node:fs";
import {createHash, randomUUID} from "node:crypto";
import {basename, join} from "node:path";
import type {Locator, Page, Request} from "playwright";
import {PDFParse} from "pdf-parse";
import {BrowserHarness} from "./browser.js";
import {boundedFetch, type BoundedFetchResult} from "./bounded-fetch.js";
import {
  alarmMediaForensicsPassed,
  assertAlarmVideoAssociationUnique,
  assessAlarmMediaForensics,
  assessAlarmVideoObservation,
  cameraUidsForSystemComponents,
  laneUidForSystemName,
  type AlarmVideoAssociation,
} from "./alarm-media-oracles.js";
import {
  assessDashboardConnectionResolution,
  assessHealthObservationBatches,
  connectionDataStreamIds,
  DASHBOARD_HEALTH_MAX_BATCH_STREAMS,
  DASHBOARD_HEALTH_MAX_IN_FLIGHT,
  expectedDashboardConnectionIds,
  forceConnectionObservationsOffline,
  forceSingleConnectionObservationOffline,
  parseHealthObservationBatch,
} from "./dashboard-health.js";
import {
  assessViewerCachePolicy,
  canonicalAlarmTransferDocumentJson,
  importedAlarmChartsRendered,
  operationalViewScopePair,
  scopedUuidOperationalViewChecksEnabled,
  type AlarmChartCanvasSnapshot,
  type AlarmChartSeries,
} from "./coverage-oracles.js";
import {RpmEmulatorClient} from "./emulator.js";
import {REQUIRED_OPERATIONAL_VIEW_KEYS} from "./lane-config.js";
import {MetricsSampler} from "./metrics.js";
import {navigateWithBoundedRetry} from "./navigation.js";
import {RunReporter} from "./reporter.js";
import {StorageProbeClient} from "./storage-probe.js";
import {
  archiveScratchIsSafe,
  assessArchiveHealth,
  assessArchiveScratch,
  assessJpeg,
  assessMediaMetadataHealth,
  assessRetainedMediaResponse,
  assessStoragePlatform,
  encodeOshBigId,
  MAX_RETAINED_FRAME_BYTES,
  mediaMetadataHealthIsSafe,
  OSCAR_STORAGE_SCHEMA_CHECKSUM,
  OSCAR_STORAGE_SCHEMA_VERSION,
  parseCollectionIds,
  storagePlatformHasExactReleaseIdentity,
  storageMetricFromProbe,
} from "./storage-oracles.js";
import {isPublicObservationId} from "./public-observation-id.js";
import {
  assessDailyJournalStatus,
  type DailyJournalStatus,
} from "./daily-journal-oracle.js";
import type {RpmConfig, RpmStatus, SuiteConfig} from "./types.js";
import {describeError, normalizePathname, poll, safeName, sleep} from "./util.js";

interface ProbeResult<T = undefined> {
  passed: boolean;
  observed: string;
  value?: T;
  evidence?: string;
}

interface CheckMetadata {
  scenario: string;
  category: string;
  action: string;
  target: string;
  expected: string;
}

interface ReportCase {
  reportType: "RDS_SITE" | "LANE" | "EVENT" | "ADJUDICATION";
  eventType?: "ALARMS" | "ALARMS_OCCUPANCIES" | "SOH";
}

interface ExportedAlarmArtifacts {
  alarmFile: string;
  qrImage: string;
}

interface GeneratedAlarmMedia {
  alarmType: "gamma" | "neutron";
  occupancyCount: number;
  association: AlarmVideoAssociation;
}

const MAX_RETAINED_CATALOG_BYTES = 4 * 1024 * 1024;

function parseBoundedJson(response: BoundedFetchResult, context: string): unknown {
  if (!response.ok) throw new Error(`${context} returned HTTP ${response.status}`);
  if (response.contentType !== "application/json") {
    throw new Error(`${context} returned ${response.contentType || "no content type"}, not application/json`);
  }
  const bytes = Buffer.from(response.bodyBase64, "base64");
  if (bytes.length !== response.byteCount) throw new Error(`${context} base64 length mismatch`);
  try {
    return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
  } catch (error) {
    throw new Error(`${context} returned invalid bounded JSON`, {cause: error});
  }
}

interface DirectJournalLaneState {
  directoryId: string;
  present: boolean;
  files: number;
  bytes: number;
  openSegments: number;
  sealedSegments: number;
  partialFiles: number;
  unsafeEntries: number;
  segments: Array<{
    path: string;
    kind: "open" | "seg";
    bytes: number;
    sha256: string;
  }>;
}

function directJournalInventoryValid(state: DirectJournalLaneState): boolean {
  if (!Array.isArray(state.segments) || state.segments.length !== state.files ||
      state.segments.length > 512) return false;
  const paths = new Set<string>();
  let bytes = 0;
  let open = 0;
  let sealed = 0;
  for (const segment of state.segments) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9]{6}\.(?:open|seg)$/.test(segment.path) ||
        !["open", "seg"].includes(segment.kind) ||
        !Number.isSafeInteger(segment.bytes) || segment.bytes < 0 ||
        !/^[0-9a-f]{64}$/.test(segment.sha256) || paths.has(segment.path) ||
        !segment.path.endsWith(`.${segment.kind}`)) return false;
    paths.add(segment.path);
    bytes += segment.bytes;
    if (!Number.isSafeInteger(bytes)) return false;
    if (segment.kind === "open") open++;
    else sealed++;
  }
  return bytes === state.bytes && open === state.openSegments && sealed === state.sealedSegments;
}

type DashboardConnectionKind = "rpm" | "camera";
type DashboardConnectionState = "online" | "offline" | "unknown";
type DashboardFaultKind = "gamma-high" | "gamma-low" | "neutron-high" | "tamper" | "extended-occupancy";

const DASHBOARD_FAULT_KINDS: DashboardFaultKind[] = [
  "gamma-high",
  "gamma-low",
  "neutron-high",
  "tamper",
  "extended-occupancy",
];

const DASHBOARD_FAULT_LABELS: Record<DashboardFaultKind, string> = {
  "gamma-high": "Gamma high",
  "gamma-low": "Gamma low",
  "neutron-high": "Neutron high",
  tamper: "Tamper",
  "extended-occupancy": "Extended occupancy",
};

const REGRESSION_MEDIA_RETENTION = {
  enabled: true,
  timeToRetentionDays: 0,
  queryPeriodMinutes: 1,
  frameCount: 5,
  jpegQuality: 85,
  sourceRollbackGraceHours: 24,
  metadataReclamationWorkLimit: 200,
} as const;

const REGRESSION_ARCHIVE_RESOURCES = {
  memoryLimitMegabytes: 256,
  threads: 2,
  maximumTemporaryMegabytes: 4096,
  maximumConcurrentSessions: 2,
  sessionAcquireTimeoutSeconds: 30,
  temporaryDirectory: "/var/lib/oscar/duckdb-tmp",
} as const;

function isVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

export class RegressionScenarios {
  private originalRpmConfig: RpmConfig | undefined;
  private originalRpmRunning: boolean | undefined;
  private originalRpmStatus: RpmStatus | null | undefined;
  private reservedLanePrepared = false;
  private alarmMediaBaselineCreated = false;
  private alarmMediaProbe: StorageProbeClient | undefined;
  private alarmCameraUids: string[] | undefined;
  private alarmLaneUid: string | undefined;
  private readonly generatedAlarmMedia = new Map<string, GeneratedAlarmMedia>();
  private readonly retainedBackupExpectations = new Map<string, string>();
  private retainedMediaProofDeferred = false;
  private stopRequested: () => boolean = () => false;
  private activeScenario = "navigation";

  constructor(
    private readonly config: SuiteConfig,
    private readonly reporter: RunReporter,
    private readonly browser: BrowserHarness,
    private readonly emulator: RpmEmulatorClient,
    private readonly metrics: MetricsSampler,
  ) {}

  setStopRequested(callback: () => boolean): void {
    this.stopRequested = callback;
  }

  private selected(scenario: string): boolean {
    return this.config.scenarioFilter.size === 0 || this.config.scenarioFilter.has(scenario);
  }

  private fullRunCanSelfSeedRetainedMedia(): boolean {
    return ["full", "3.9.2-release"].includes(this.config.profile) &&
      this.selected("storage-lifecycle") &&
      ["rpm-alarms", "event-uuid", "adjudication"].some(scenario => this.selected(scenario));
  }

  private async check<T>(metadata: CheckMetadata, probe: () => Promise<ProbeResult<T>>): Promise<T | undefined> {
    const started = Date.now();
    try {
      const result = await probe();
      this.reporter.outcome(
        metadata.scenario,
        metadata.category,
        metadata.action,
        metadata.target,
        metadata.expected,
        result.observed,
        result.passed ? "correct" : "incorrect",
        Date.now() - started,
        result.evidence ?? "",
      );
      return result.value;
    } catch (error) {
      this.reporter.outcome(
        metadata.scenario,
        metadata.category,
        metadata.action,
        metadata.target,
        metadata.expected,
        "operation failed",
        "incorrect",
        Date.now() - started,
        "",
        describeError(error),
      );
      this.reporter.error(metadata.scenario, metadata.action, error);
      return undefined;
    }
  }

  private skip(metadata: CheckMetadata, reason: string): void {
    this.reporter.outcome(
      metadata.scenario,
      metadata.category,
      metadata.action,
      metadata.target,
      metadata.expected,
      reason,
      "skipped",
      0,
    );
  }

  private async scenario(name: string, operation: () => Promise<void>, force = false): Promise<void> {
    if (!force && !this.selected(name)) return;
    if (this.stopRequested()) return;
    process.stdout.write(`[scenario] ${name} started\n`);
    this.activeScenario = name;
    this.browser.setScenario(name);
    this.metrics.setPhase(name);
    try {
      await operation();
    } catch (error) {
      this.reporter.error(name, "scenario", error);
      this.reporter.outcome(
        name,
        "harness",
        "complete scenario",
        name,
        "scenario completes without an unhandled error",
        "unhandled scenario error",
        "incorrect",
        0,
        "",
        describeError(error),
      );
    } finally {
      process.stdout.write(`[scenario] ${name} completed\n`);
    }
  }

  private viewerUrl(path: string): string {
    return new URL(path, `${this.config.oscarBaseUrl}/`).toString();
  }

  private healthRow(page: Page): Locator {
    return page.getByTestId(`health-lane-${this.config.testLaneLabel}`);
  }

  private dashboardCard(page: Page): Locator {
    return page.getByTestId(`lane-health-card-${this.config.testLaneLabel}`);
  }

  private dashboardConnection(page: Page, kind: DashboardConnectionKind): Locator {
    return page.getByTestId(`lane-health-${this.config.testLaneLabel}-${kind}`);
  }

  private dashboardFault(page: Page, kind: DashboardFaultKind): Locator {
    return page.getByTestId(`lane-health-${this.config.testLaneLabel}-${kind}`);
  }

  private async dashboardCameraConnectionTarget(
    page: Page,
    requestedHealthStreamIds: ReadonlySet<string>,
  ): Promise<{componentId: string; streamId: string}> {
    const camera = this.dashboardConnection(page, "camera").first();
    const componentId = await camera.getAttribute("data-component-id");
    if (!componentId) {
      throw new Error(`${this.config.testLaneLabel} has no camera component identity`);
    }

    const response = await page.context().request.get(this.viewerUrl(
      `/sensorhub/api/systems/${encodeURIComponent(componentId)}/datastreams?validTime=latest&limit=100`,
    ));
    if (!response.ok()) {
      throw new Error(`Camera datastream discovery returned HTTP ${response.status()}`);
    }
    const candidates = connectionDataStreamIds(await response.json())
      .filter((streamId) => requestedHealthStreamIds.has(streamId));
    if (candidates.length !== 1) {
      throw new Error(
        `Expected exactly one requested connection datastream for the selected camera; found ${candidates.length}`,
      );
    }
    return {componentId, streamId: candidates[0] ?? ""};
  }

  private async goto(page: Page, path: string): Promise<number> {
    const url = this.viewerUrl(path);
    return navigateWithBoundedRetry({
      navigate: async () => {
        const response = await page.goto(url, {waitUntil: "domcontentloaded"});
        return response?.status() ?? 0;
      },
      verifyTarget: async () => {
        const request = page.context().request;
        const healthResponse = await request.get(this.viewerUrl("/healthz"));
        try {
          if (healthResponse.status() !== 200) {
            throw new Error(`Viewer health probe returned HTTP ${healthResponse.status()}`);
          }
        } finally {
          await healthResponse.dispose();
        }

        const sessionResponse = await request.get(this.viewerUrl("/session"));
        try {
          if (!sessionResponse.ok()) {
            throw new Error(`Authenticated Viewer session probe returned HTTP ${sessionResponse.status()}`);
          }
          const session = await sessionResponse.json() as {username?: unknown};
          if (session.username !== this.config.oscarUsername) {
            throw new Error("Authenticated Viewer session probe returned the wrong user");
          }
        } finally {
          await sessionResponse.dispose();
        }
      },
      onFirstFailure: (error) => this.reporter.error(
        this.activeScenario,
        "viewer-navigation-retry",
        `GET ${url}: ${describeError(error)}; target probes must pass before one bounded retry`,
        "",
        "warning",
      ),
      wait: sleep,
    });
  }

  private async screenshotOnFailure(page: Page, name: string): Promise<string> {
    try { return await this.browser.screenshot(page, name); } catch { return ""; }
  }

  async runReadOnly(): Promise<void> {
    await this.scenario("preflight", () => this.preflight());
    await this.scenario("viewer-navigation", () => this.viewerNavigation());
    await this.scenario("map-national-servers", () => this.mapNationalServers());
    await this.scenario("sensorhub-admin", () => this.sensorHubAdmin());
    await this.scenario("status-of-health", () => this.statusOfHealthBaseline());
    await this.scenario("dashboard-health", () => this.dashboardHealthBaseline());
    await this.scenario("lane-video", () => this.laneVideo());
    await this.scenario("event-filtering", () => this.eventFiltering());
    await this.scenario("operational-views", () => this.operationalViews());
    await this.scenario("reporting", () => this.reporting([
      {reportType: "RDS_SITE"},
      {reportType: "EVENT", eventType: "ALARMS"},
      {reportType: "EVENT", eventType: "ALARMS_OCCUPANCIES"},
      {reportType: "EVENT", eventType: "SOH"},
      {reportType: "LANE"},
    ]));
    await this.scenario("alarm-transfer", () => this.alarmTransferValidation());
    await this.scenario("alarm-transfer-camera", () => this.alarmTransferCamera());
    await this.scenario("storage-health", () => this.storageHealth());
  }

  async runFull(): Promise<void> {
    try {
      try {
        await this.hardMutationPreflight();
        await this.prepareReservedLane();
        await this.scenario("rpm-connection", () => this.connectionFault());
        await this.scenario("rpm-faults", () => this.faults());
        await this.scenario("rpm-alarms", () => this.alarms());
        await this.scenario("event-uuid", () => this.eventUuidWorkflow());
        await this.scenario("adjudication", () => this.adjudicationAndAlarmTransfer());
        await this.scenario("extended-occupancy", () => this.extendedOccupancy());
        await this.scenario("adjudication-report", () => this.reporting([{reportType: "ADJUDICATION"}]));
        // Keep the reserved RPM's automatic occupancy/alarm generation disabled until the
        // scoped media baseline has been reconciled. Restoring its original random workload
        // earlier could create legitimate, unrelated clips in the same camera directories and
        // make an orphan check nondeterministic.
        await this.scenario("storage-lifecycle", () => this.storageLifecycle());
      } finally {
        await this.restoreReservedLane();
      }
    } finally {
      await this.alarmMediaProbe?.cleanup();
      this.alarmMediaProbe = undefined;
    }
  }

  async runRestoreDrill(): Promise<void> {
    await this.scenario("storage-restore-drill", () => this.storageRestoreDrill());
  }

  async emergencyCleanup(): Promise<void> {
    try {
      await this.restoreReservedLane();
    } finally {
      await this.alarmMediaProbe?.cleanup();
      this.alarmMediaProbe = undefined;
    }
  }

  private async hardMutationPreflight(): Promise<void> {
    const started = Date.now();
    const page = await this.browser.oscarPage();
    try {
      const rpm = await this.emulator.get(this.config.testRpmId);
      if (!rpm.running) throw new Error(`${this.config.testRpmId} is not running`);
      const status = await this.emulator.status(this.config.testRpmId);
      if (status.connected_clients < 1) {
        throw new Error(`${this.config.testRpmId} has no connected OSCAR client`);
      }
      if (await this.browser.sessionUsername() !== this.config.oscarUsername) {
        throw new Error("OSCAR session identity changed before mutation");
      }
      await this.goto(page, "/health");
      const row = this.healthRow(page);
      await row.waitFor({timeout: this.config.uiTimeoutMs});
      const rowText = await row.innerText();
      if (!/RPM/i.test(rowText) || !/Camera/i.test(rowText)) {
        throw new Error(`${this.config.testLaneLabel} does not expose the expected RPM/camera mapping`);
      }
      this.reporter.outcome(
        "mutation-preflight", "safety", "verify reserved RPM-to-lane mapping",
        `${this.config.testRpmId}:${this.config.testLaneLabel}`,
        "acknowledged emulator RPM exists, is connected, and its Viewer health row exposes RPM/camera telemetry",
        `rpm=${rpm.name}; clients=${status.connected_clients}; health row mapped=true`,
        "correct", Date.now() - started,
      );
    } catch (error) {
      this.reporter.outcome(
        "mutation-preflight", "safety", "verify reserved RPM-to-lane mapping",
        `${this.config.testRpmId}:${this.config.testLaneLabel}`,
        "all mutation safety checks pass", "mutation blocked", "incorrect",
        Date.now() - started, "", describeError(error),
      );
      throw error;
    } finally {
      await page.close();
    }
  }

  private async preflight(): Promise<void> {
    await this.check({
      scenario: "preflight", category: "availability", action: "open OSCAR Viewer",
      target: this.config.oscarBaseUrl, expected: "authenticated Viewer responds without a server error",
    }, async () => {
      const page = await this.browser.oscarPage();
      try {
        const status = await this.goto(page, "/");
        const body = await page.locator("body").innerText();
        const sessionUsername = await this.browser.sessionUsername();
        const passed = status >= 200 && status < 400 &&
          sessionUsername === this.config.oscarUsername &&
          !/internal server error|sign in to continue/i.test(body);
        return {passed, observed: `HTTP ${status}; session user=${sessionUsername}; title=${await page.title()}`};
      } finally { await page.close(); }
    });

    await this.check({
      scenario: "preflight", category: "performance", action: "verify Viewer browser cache policy",
      target: "/_next/static and /sw.js",
      expected: "authenticated hashed assets are privately immutable, the service worker is revalidated, and anonymous asset errors are not cacheable",
    }, async () => {
      const page = await this.browser.oscarPage();
      try {
        await this.goto(page, "/");
        const scriptPath = await page.locator('script[src^="/_next/static/"]').first().getAttribute("src");
        if (!scriptPath) throw new Error("Viewer page did not expose a hashed static script");

        const request = page.context().request;
        const [assetResponse, serviceWorkerResponse, unauthenticatedAsset] = await Promise.all([
          request.get(this.viewerUrl(scriptPath)),
          request.get(this.viewerUrl("/sw.js")),
          this.browser.unauthenticatedOscarGet(scriptPath),
        ]);
        try {
          const assetCache = assetResponse.headers()["cache-control"] ?? "";
          const serviceWorkerCache = serviceWorkerResponse.headers()["cache-control"] ?? "";
          const assessment = assessViewerCachePolicy({
            authenticatedAsset: {status: assetResponse.status(), cacheControl: assetCache},
            serviceWorker: {status: serviceWorkerResponse.status(), cacheControl: serviceWorkerCache},
            unauthenticatedAsset,
          });
          return {
            passed: assessment.passed,
            observed: `asset HTTP ${assetResponse.status()} Cache-Control=${assetCache || "missing"}; ` +
              `sw.js HTTP ${serviceWorkerResponse.status()} Cache-Control=${serviceWorkerCache || "missing"}; ` +
              `anonymous asset HTTP ${unauthenticatedAsset.status} ` +
              `Cache-Control=${unauthenticatedAsset.cacheControl || "missing"}; ` +
              `protected=${assessment.unauthenticatedAssetProtected}; ` +
              `not cacheable=${assessment.unauthenticatedAssetNotCacheable}`,
          };
        } finally {
          await Promise.all([assetResponse.dispose(), serviceWorkerResponse.dispose()]);
        }
      } finally {
        await page.close();
      }
    });

    await this.check({
      scenario: "preflight", category: "availability", action: "discover RPM emulator",
      target: this.config.rpmEmulatorUrl, expected: `${this.config.expectedLaneCount} RPMs and ${this.config.testRpmId} running`,
    }, async () => {
      const rpms = await this.emulator.list();
      const reserved = rpms.find((rpm) => rpm.id === this.config.testRpmId);
      return {
        passed: rpms.length === this.config.expectedLaneCount && reserved?.running === true,
        observed: `${rpms.length} RPMs; reserved lane running=${String(reserved?.running)}`,
      };
    });
  }

  private async viewerNavigation(): Promise<void> {
    const routes = [
      ["/", "Lane Status"],
      ["/event-log", "Events"],
      ["/health", "Status of Health"],
      ["/report", "Report Generator"],
      ["/alarm-transfer", "Alarm Transfer"],
      ["/map", "Map"],
      ["/national-view", "National"],
      ["/servers", "Nodes"],
    ] as const;
    const page = await this.browser.oscarPage();
    try {
      for (const [path, marker] of routes) {
        await this.check({
          scenario: "viewer-navigation", category: "viewer", action: `open ${path}`,
          target: path, expected: `HTTP success and visible ${marker} content`,
        }, async () => {
          const status = await this.goto(page, path);
          const markerLocator = page.getByRole("heading", {name: marker, exact: true}).first();
          const markerVisible = await markerLocator.waitFor({timeout: this.config.uiTimeoutMs})
            .then(() => true).catch(() => false);
          const body = await page.locator("body").innerText();
          const passed = status >= 200 && status < 400 && markerVisible && !/application error|internal server error/i.test(body);
          const evidence = passed ? "" : await this.screenshotOnFailure(page, `viewer-${safeName(path)}-failed`);
          return {passed, observed: `HTTP ${status}; marker visible=${markerVisible}`, evidence};
        });
      }
    } finally { await page.close(); }
  }

  private async mapNationalServers(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      await this.check({
        scenario: "map-national-servers", category: "map", action: "render site map",
        target: "/map", expected: "interactive map container renders at non-zero size",
      }, async () => {
        await this.goto(page, "/map");
        const map = page.locator("#mapcontainer");
        await map.waitFor();
        const box = await map.boundingBox();
        return {
          passed: Boolean(box && box.width > 100 && box.height > 100),
          observed: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "no rendered map box",
        };
      });

      await this.check({
        scenario: "map-national-servers", category: "national", action: "refresh national statistics",
        target: "/national-view", expected: "statistics refresh completes and renders the local node row",
      }, async () => {
        await this.goto(page, "/national-view");
        const refresh = page.getByRole("button", {name: "Refresh Statistics"});
        await refresh.waitFor();
        const commandResponse = page.waitForResponse(
          (response) => response.request().method() === "POST" &&
            /\/controlstreams\/[^/]+\/commands/.test(new URL(response.url()).pathname),
          {timeout: this.config.eventTimeoutMs},
        );
        await refresh.click();
        const response = await commandResponse;
        await poll(
          () => refresh.isEnabled(),
          (enabled) => enabled,
          {timeoutMs: 90_000, intervalMs: 1_000, description: "national statistics refresh to complete"},
        );
        const body = await page.locator("body").innerText();
        const hasNode = /Local Node/i.test(body);
        return {
          passed: response.ok() && hasNode,
          observed: `command HTTP ${response.status()}; Local Node rendered=${hasNode}`,
        };
      });

      await this.check({
        scenario: "map-national-servers", category: "configuration", action: "inspect server management",
        target: "/servers", expected: "Nodes list and Add Server form render without changing configuration",
      }, async () => {
        await this.goto(page, "/servers");
        const nodes = page.getByRole("heading", {name: "Nodes", exact: true});
        const addServer = page.getByRole("heading", {name: "Add a New Server", exact: true});
        await Promise.all([nodes.waitFor(), addServer.waitFor()]);
        const body = await page.locator("body").innerText();
        return {passed: /Local Node/i.test(body), observed: `Local Node listed=${/Local Node/i.test(body)}`};
      });
    } finally { await page.close(); }
  }

  private async sensorHubAdmin(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      await this.check({
        scenario: "sensorhub-admin", category: "admin", action: "open SensorHub Admin GUI",
        target: "/sensorhub/admin", expected: "Admin application loads with sensor/module controls",
      }, async () => {
        const status = await this.goto(page, "/sensorhub/admin");
        await page.waitForTimeout(2_000);
        const body = await page.locator("body").innerText();
        const hasAdminContent = /sensorhub|admin|module|sensor|system/i.test(body) && body.trim().length > 100;
        const passed = status >= 200 && status < 400 && hasAdminContent;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "sensorhub-admin-load");
        return {passed, observed: `HTTP ${status}; body characters=${body.length}`, evidence};
      });

      await this.check({
        scenario: "sensorhub-admin", category: "admin", action: "verify configured sensors are visible",
        target: "/sensorhub/admin", expected: `Admin UI exposes Sensors and the systems API contains ${this.config.testLaneLabel}`,
      }, async () => {
        const body = await page.locator("body").innerText();
        const response = await page.context().request.get(
          this.viewerUrl("/sensorhub/api/systems?searchMembers=true&validTime=latest&limit=500"),
        );
        const systems = response.ok() ? JSON.stringify(await response.json()) : "";
        const sensorRootVisible = /\bSensors\b/.test(body);
        const knownLanePresent = systems.toLowerCase().includes(this.config.testLaneLabel.toLowerCase());
        const passed = response.ok() && sensorRootVisible && knownLanePresent;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "sensorhub-admin-no-sensors");
        return {
          passed,
          observed: `systems HTTP ${response.status()}; Sensors visible=${sensorRootVisible}; known lane present=${knownLanePresent}`,
          evidence,
        };
      });
    } finally { await page.close(); }
  }

  private async statusOfHealthBaseline(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      await this.goto(page, "/health");
      await page.getByRole("heading", {name: "Status of Health"}).waitFor();
      await page.locator("tbody tr").first().waitFor();
      await this.check({
        scenario: "status-of-health", category: "health", action: "enumerate lanes",
        target: "Status of Health table", expected: `${this.config.expectedLaneCount} unique expected lane identities`,
      }, async () => {
        const laneIds = (await page.locator("tbody tr").evaluateAll((rows) => rows.map((row) =>
          (row.getAttribute("data-testid") ?? "").replace(/^health-lane-/, ""),
        ))).filter(Boolean);
        const uniqueLaneIds = new Set(laneIds);
        const numberedLane = this.config.testLaneLabel.match(/^(.*?)(\d+)$/);
        const expectedLaneIds = numberedLane && Number(numberedLane[2]) === this.config.expectedLaneCount
          ? Array.from(
            {length: this.config.expectedLaneCount},
            (_, index) => `${numberedLane[1]}${String(index + 1).padStart(numberedLane[2]?.length ?? 1, "0")}`,
          )
          : [];
        const missing = expectedLaneIds.filter((laneId) => !uniqueLaneIds.has(laneId));
        const unexpected = expectedLaneIds.length
          ? [...uniqueLaneIds].filter((laneId) => !expectedLaneIds.includes(laneId))
          : [];
        const passed = laneIds.length === this.config.expectedLaneCount &&
          uniqueLaneIds.size === laneIds.length && missing.length === 0 && unexpected.length === 0;
        return {
          passed,
          observed: `${laneIds.length} rows; ${uniqueLaneIds.size} unique; missing=${missing.join("|") || "none"}; unexpected=${unexpected.join("|") || "none"}`,
        };
      });
      await this.check({
        scenario: "status-of-health", category: "health", action: "enumerate cameras",
        target: "Status of Health connections", expected: `${this.config.expectedCameraCount} camera indicators mapped to individual lanes`,
      }, async () => {
        const perLane = await page.locator("tbody tr").evaluateAll((rows) => rows.map((row) => ({
          laneId: (row.getAttribute("data-testid") ?? "").replace(/^health-lane-/, ""),
          cameras: [...row.querySelectorAll(".MuiChip-label")]
            .filter((chip) => /camera/i.test(chip.textContent ?? "")).length,
        })));
        const cameraCount = perLane.reduce((total, lane) => total + lane.cameras, 0);
        const invalidMappings = perLane.filter((lane) => lane.cameras !== 1).map((lane) => `${lane.laneId}:${lane.cameras}`);
        const requireOnePerLane = this.config.expectedCameraCount === this.config.expectedLaneCount;
        const passed = cameraCount === this.config.expectedCameraCount &&
          (!requireOnePerLane || invalidMappings.length === 0);
        return {
          passed,
          observed: `${cameraCount} camera indicators; invalid lane mappings=${invalidMappings.join("|") || "none"}`,
        };
      });
      await this.check({
        scenario: "status-of-health", category: "health", action: "verify reserved lane telemetry",
        target: this.config.testLaneLabel, expected: "RPM and camera connection plus all five fault indicators visible",
      }, async () => {
        const row = this.healthRow(page);
        await row.waitFor();
        const text = await row.innerText();
        const labels = ["RPM", "Camera", "Gamma high", "Gamma low", "Neutron high", "Tamper", "Extended occupancy"];
        const missing = labels.filter((label) => !text.toLowerCase().includes(label.toLowerCase()));
        const passed = missing.length === 0;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "health-reserved-lane-missing-fields");
        return {passed, observed: missing.length ? `missing: ${missing.join(", ")}` : "all indicators visible", evidence};
      });
      await this.check({
        scenario: "status-of-health", category: "health", action: "resolve all connection states",
        target: "Status of Health table", expected: "every RPM and configured camera resolves to Online rather than Waiting",
      }, async () => {
        const connectionState = async () => page.locator("tbody tr").evaluateAll((rows) => rows.map((row) => ({
          laneId: (row.getAttribute("data-testid") ?? "").replace(/^health-lane-/, ""),
          chips: [...row.querySelectorAll(".MuiChip-label")]
            .map((chip) => (chip.textContent ?? "").replace(/\s+/g, " ").trim())
            .filter((text) => /RPM|Camera/i.test(text)),
        })));
        const states = await poll(
          connectionState,
          (value) => value.every((lane) => lane.chips.every((chip) => /·\s*Online/i.test(chip))),
          {timeoutMs: 40_000, intervalMs: 1_000, description: "all RPM and camera connection telemetry to resolve online"},
        ).catch(connectionState);
        const connections = states.flatMap((lane) => lane.chips.map((chip) => ({laneId: lane.laneId, chip})));
        const waiting = connections.filter(({chip}) => /Waiting/i.test(chip));
        const offline = connections.filter(({chip}) => /Offline/i.test(chip));
        const online = connections.filter(({chip}) => /·\s*Online/i.test(chip));
        const expectedConnections = this.config.expectedLaneCount + this.config.expectedCameraCount;
        const invalidRows = states.filter((lane) => {
          const rpmCount = lane.chips.filter((chip) => /RPM/i.test(chip)).length;
          const cameraCount = lane.chips.filter((chip) => /Camera/i.test(chip)).length;
          return rpmCount !== 1 ||
            (this.config.expectedCameraCount === this.config.expectedLaneCount && cameraCount !== 1);
        });
        const passed = connections.length === expectedConnections && online.length === expectedConnections &&
          waiting.length === 0 && offline.length === 0 && invalidRows.length === 0;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "health-unresolved-connections");
        return {
          passed,
          observed: `${online.length}/${expectedConnections} online; waiting=${waiting.length}; offline=${offline.length}; invalid rows=${invalidRows.map((lane) => lane.laneId).join("|") || "none"}`,
          evidence,
        };
      });
    } finally { await page.close(); }
  }

  private async openDashboard(page: Page): Promise<Locator> {
    await this.goto(page, "/");
    const card = this.dashboardCard(page);
    await card.waitFor({timeout: this.config.uiTimeoutMs});
    return card;
  }

  private async waitDashboardConnectionState(
    page: Page,
    kind: DashboardConnectionKind,
    state: DashboardConnectionState,
    timeoutMs = 60_000,
  ): Promise<number> {
    await this.openDashboard(page);
    const indicators = this.dashboardConnection(page, kind);
    return poll(
      async () => {
        const count = await indicators.count();
        const states = await Promise.all(Array.from(
          {length: count},
          (_, index) => indicators.nth(index).getAttribute("data-state"),
        ));
        return {count, states};
      },
      (value) => value.count > 0 && value.states.every((valueState) => valueState === state),
      {
        timeoutMs,
        intervalMs: 1_000,
        description: `${this.config.testLaneLabel} dashboard ${kind} indicators to become ${state}`,
      },
    ).then((value) => value.count);
  }

  private async waitDashboardFaultState(
    page: Page,
    kind: DashboardFaultKind,
    state: "active" | "unknown" | "clear",
    timeoutMs = 60_000,
  ): Promise<number> {
    await this.openDashboard(page);
    const indicator = this.dashboardFault(page, kind);
    if (state === "clear") {
      return poll(
        () => indicator.count(),
        (count) => count === 0,
        {
          timeoutMs,
          intervalMs: 1_000,
          description: `${this.config.testLaneLabel} dashboard ${kind} indicator to clear`,
        },
      );
    }

    return poll(
      async () => ({count: await indicator.count(), state: await indicator.first().getAttribute("data-state").catch(() => null)}),
      (value) => value.count > 0 && value.state === state,
      {
        timeoutMs,
        intervalMs: 1_000,
        description: `${this.config.testLaneLabel} dashboard ${kind} indicator to become ${state}`,
      },
    ).then((value) => value.count);
  }

  private async dashboardHealthBaseline(): Promise<void> {
    const page = await this.browser.oscarPage();
    const healthRoutePattern = /\/observations\/?(?:\?|$)/;
    let fixtureMode: "live" | "mixed" | "offline" | "unknown" = "live";
    let forcedConnectionObservations = 0;
    let mixedTargetStreamId = "";
    let mixedConnectionObservations = 0;
    let mixedOfflineObservations = 0;
    let unknownHealthResponses = 0;
    const unknownHealthStreamIds = new Set<string>();
    let probeEnabled = true;
    let currentHealthRequests = 0;
    let peakHealthRequests = 0;
    const trackedRequests = new Set<Request>();
    const batches: Array<{streamIds: string[]; limit: number | null}> = [];

    const requestStarted = (request: Request) => {
      if (!probeEnabled) return;
      const batch = parseHealthObservationBatch(request.url());
      if (!batch) return;
      trackedRequests.add(request);
      batches.push(batch);
      currentHealthRequests++;
      peakHealthRequests = Math.max(peakHealthRequests, currentHealthRequests);
    };
    const requestSettled = (request: Request) => {
      if (!trackedRequests.delete(request)) return;
      currentHealthRequests = Math.max(0, currentHealthRequests - 1);
    };

    page.on("request", requestStarted);
    page.on("requestfinished", requestSettled);
    page.on("requestfailed", requestSettled);
    await page.route(healthRoutePattern, async (route) => {
      const batch = parseHealthObservationBatch(route.request().url());
      if (!batch || fixtureMode === "live") {
        await route.continue();
        return;
      }
      if (fixtureMode === "unknown") {
        unknownHealthResponses++;
        batch.streamIds.forEach((streamId) => unknownHealthStreamIds.add(streamId));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({items: []}),
        });
        return;
      }

      const response = await route.fetch();
      const payload: unknown = await response.json();
      if (fixtureMode === "mixed") {
        const summary = forceSingleConnectionObservationOffline(payload, mixedTargetStreamId);
        mixedConnectionObservations += summary.matched;
        mixedOfflineObservations += summary.offlineMatched;
      } else {
        forcedConnectionObservations += forceConnectionObservationsOffline(payload);
      }
      await route.fulfill({response, json: payload});
    });

    try {
      const card = await this.openDashboard(page);
      await this.check({
        scenario: "dashboard-health", category: "dashboard-health", action: "enumerate compact lane health indicators",
        target: "Dashboard Lane Status", expected: `${this.config.expectedLaneCount} cards, one RPM per lane, and ${this.config.expectedCameraCount} independently identified cameras`,
      }, async () => {
        const cards = page.locator('[data-testid^="lane-health-card-"]');
        const rpms = page.locator('[data-testid^="lane-health-"][data-testid$="-rpm"]');
        const cameras = page.locator('[data-testid^="lane-health-"][data-testid$="-camera"]');
        const [cardCount, rpmCount, cameraCount, cameraIds, perCard] = await Promise.all([
          cards.count(),
          rpms.count(),
          cameras.count(),
          cameras.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-component-id") ?? "")),
          cards.evaluateAll((nodes) => nodes.map((node) => ({
            lane: (node.getAttribute("data-testid") ?? "").replace(/^lane-health-card-/, ""),
            rpms: node.querySelectorAll('[data-testid$="-rpm"]').length,
            cameras: node.querySelectorAll('[data-testid$="-camera"]').length,
          }))),
        ]);
        const uniqueCameraIds = new Set(cameraIds.filter(Boolean));
        const invalidRpmMappings = perCard.filter((lane) => lane.rpms !== 1);
        const requireOneCameraPerLane = this.config.expectedCameraCount === this.config.expectedLaneCount;
        const invalidCameraMappings = requireOneCameraPerLane
          ? perCard.filter((lane) => lane.cameras !== 1)
          : [];
        const passed = cardCount === this.config.expectedLaneCount &&
          rpmCount === this.config.expectedLaneCount &&
          cameraCount === this.config.expectedCameraCount &&
          uniqueCameraIds.size === cameraCount &&
          invalidRpmMappings.length === 0 && invalidCameraMappings.length === 0;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-health-inventory");
        return {
          passed,
          observed: `cards=${cardCount}; RPMs=${rpmCount}; cameras=${cameraCount}; unique camera IDs=${uniqueCameraIds.size}; invalid RPM mappings=${invalidRpmMappings.map((lane) => `${lane.lane}:${lane.rpms}`).join("|") || "none"}; invalid canonical camera mappings=${invalidCameraMappings.map((lane) => `${lane.lane}:${lane.cameras}`).join("|") || "none"}`,
          evidence,
        };
      });

      await this.check({
        scenario: "dashboard-health", category: "dashboard-health", action: "resolve dashboard connection indicators",
        target: "Dashboard Lane Status", expected: "every exact expected RPM and configured camera indicator resolves independently to Online within 45 seconds",
      }, async () => {
        const indicators = page.locator('[data-testid^="lane-health-"][data-testid$="-rpm"], [data-testid^="lane-health-"][data-testid$="-camera"]');
        const fixtureLaneNames = this.config.laneConfigOracle?.lanes.map((lane) => lane.name) ?? [];
        const renderedLaneNames = await page.locator('[data-testid^="lane-health-card-"]').evaluateAll((nodes) => nodes
          .map((node) => (node.getAttribute("data-testid") ?? "").replace(/^lane-health-card-/, ""))
          .filter(Boolean));
        const laneNames = fixtureLaneNames.length === this.config.expectedLaneCount
          ? fixtureLaneNames
          : renderedLaneNames;
        const expectedIds = expectedDashboardConnectionIds(
          laneNames,
          this.config.expectedCameraCount === this.config.expectedLaneCount,
        );
        const snapshot = () => indicators.evaluateAll((nodes) => nodes.map((node) => ({
          testId: node.getAttribute("data-testid") ?? "",
          state: node.getAttribute("data-state"),
          label: node.getAttribute("aria-label") ?? "",
        })));
        const states = await poll(
          snapshot,
          (values) => assessDashboardConnectionResolution(values, expectedIds).passed,
          {timeoutMs: 45_000, intervalMs: 1_000, description: "every exact dashboard RPM and camera indicator to resolve online"},
        ).catch(snapshot);
        const assessment = assessDashboardConnectionResolution(states, expectedIds);
        const evidence = assessment.passed ? "" : await this.screenshotOnFailure(page, "dashboard-health-live-connections");
        return {
          passed: assessment.passed,
          observed: `${assessment.online}/${expectedIds.length} exact indicators Online; missing=${assessment.missing.join("|") || "none"}; unexpected=${assessment.unexpected.join("|") || "none"}; duplicates=${assessment.duplicates.join("|") || "none"}; unresolved=${assessment.unresolved.join("|") || "none"}`,
          evidence,
        };
      });

      await poll(
        async () => trackedRequests.size,
        (count) => batches.length > 0 && count === 0,
        {timeoutMs: 15_000, intervalMs: 100, description: "initial dashboard health batches to settle"},
      );
      probeEnabled = false;
      await this.check({
        scenario: "dashboard-health", category: "performance", action: "bound shared dashboard health polling",
        target: "latest observation requests", expected: `shared batches contain at most ${DASHBOARD_HEALTH_MAX_BATCH_STREAMS} streams with at most ${DASHBOARD_HEALTH_MAX_IN_FLIGHT} requests in flight and do not fan out one REST request per lane`,
      }, async () => {
        const uniqueBatches = new Map(batches.map((batch) => [batch.streamIds.join(","), batch]));
        const values = [...uniqueBatches.values()];
        const assessment = assessHealthObservationBatches(
          values,
          this.config.expectedLaneCount,
          peakHealthRequests,
        );
        return {
          passed: assessment.passed,
          observed: `${values.length} unique batches; sizes=${values.map((batch) => batch.streamIds.length).join("|")}; peak in flight=${peakHealthRequests}; lane count=${this.config.expectedLaneCount}`,
        };
      });

      const requestedHealthStreamIds = new Set(batches.flatMap((batch) => batch.streamIds));
      const mixedTarget = await this.dashboardCameraConnectionTarget(page, requestedHealthStreamIds);
      mixedTargetStreamId = mixedTarget.streamId;
      mixedConnectionObservations = 0;
      mixedOfflineObservations = 0;
      fixtureMode = "mixed";
      await page.reload({waitUntil: "domcontentloaded"});
      await card.waitFor({timeout: this.config.uiTimeoutMs});
      await this.check({
        scenario: "dashboard-health", category: "dashboard-health", action: "render one camera Offline independently",
        target: this.config.testLaneLabel,
        expected: "exactly the selected camera is Offline while every RPM and every other camera remain Online",
      }, async () => {
        const indicators = page.locator('[data-testid^="lane-health-"][data-testid$="-rpm"], [data-testid^="lane-health-"][data-testid$="-camera"]');
        const expected = this.config.expectedLaneCount + this.config.expectedCameraCount;
        const states = await poll(
          () => indicators.evaluateAll((nodes) => nodes.map((node) => ({
            kind: node.getAttribute("data-testid")?.endsWith("-camera") ? "camera" : "rpm",
            componentId: node.getAttribute("data-component-id") ?? "",
            state: node.getAttribute("data-state"),
            label: node.getAttribute("aria-label") ?? "",
          }))),
          (values) => {
            const offline = values.filter(({state}) => state === "offline");
            return values.length === expected && offline.length === 1 &&
              offline[0]?.kind === "camera" &&
              offline[0]?.componentId === mixedTarget.componentId &&
              values.filter(({componentId}) => componentId !== mixedTarget.componentId)
                .every(({state}) => state === "online");
          },
          {timeoutMs: 45_000, intervalMs: 1_000, description: "one selected camera to render Offline independently"},
        );
        const offline = states.filter(({state}) => state === "offline");
        const labelsCorrect = states.every(({state, label}) =>
          state === "offline" ? /offline/i.test(label) : /online/i.test(label));
        const passed = mixedConnectionObservations >= expected && mixedOfflineObservations >= 1 &&
          offline.length === 1 && offline[0]?.kind === "camera" &&
          offline[0]?.componentId === mixedTarget.componentId && labelsCorrect;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-health-one-camera-offline");
        return {
          passed,
          observed: `connections=${states.length}/${expected}; Offline cameras=${offline.length}; selected camera Offline=${offline[0]?.componentId === mixedTarget.componentId}; rewritten=${mixedConnectionObservations}; target rewrites=${mixedOfflineObservations}; accessible labels=${labelsCorrect}`,
          evidence,
        };
      });

      fixtureMode = "offline";
      forcedConnectionObservations = 0;
      await page.reload({waitUntil: "domcontentloaded"});
      await card.waitFor({timeout: this.config.uiTimeoutMs});
      await this.check({
        scenario: "dashboard-health", category: "dashboard-health", action: "render independent Offline connection states",
        target: "Dashboard Lane Status", expected: "browser fixture drives every RPM and camera indicator to an accessible Offline state",
      }, async () => {
        const indicators = page.locator('[data-testid^="lane-health-"][data-testid$="-rpm"], [data-testid^="lane-health-"][data-testid$="-camera"]');
        const expected = this.config.expectedLaneCount + this.config.expectedCameraCount;
        const states = await poll(
          () => indicators.evaluateAll((nodes) => nodes.map((node) => ({
            state: node.getAttribute("data-state"),
            label: node.getAttribute("aria-label") ?? "",
          }))),
          (values) => values.length === expected && values.every(({state}) => state === "offline"),
          {timeoutMs: 45_000, intervalMs: 1_000, description: "dashboard connection indicators to render fixture Offline"},
        );
        const passed = forcedConnectionObservations >= expected &&
          states.every(({state, label}) => state === "offline" && /offline/i.test(label));
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-health-offline-fixture");
        return {
          passed,
          observed: `${states.length}/${expected} Offline; rewritten connection observations=${forcedConnectionObservations}`,
          evidence,
        };
      });

      fixtureMode = "unknown";
      unknownHealthResponses = 0;
      unknownHealthStreamIds.clear();
      await this.check({
        scenario: "dashboard-health", category: "dashboard-health", action: "render unknown connection and fault states",
        target: this.config.testLaneLabel, expected: "a completed missing-observation reconciliation changes RPM, every camera, and all five fault indicators to their exact accessible Unknown states",
      }, async () => {
        const connections = this.dashboardCard(page).locator('[data-testid$="-rpm"], [data-testid$="-camera"]');
        const state = await poll(async () => ({
          connections: await connections.evaluateAll((nodes) => nodes.map((node) => ({
            state: node.getAttribute("data-state"), label: node.getAttribute("aria-label") ?? "",
          }))),
          faults: await Promise.all(DASHBOARD_FAULT_KINDS.map(async (kind) => {
            const indicator = this.dashboardFault(page, kind);
            return {
              kind,
              count: await indicator.count(),
              state: await indicator.first().getAttribute("data-state").catch(() => null),
              label: await indicator.first().getAttribute("aria-label").catch(() => null) ?? "",
            };
          })),
          responses: unknownHealthResponses,
          allRequestedStreamsCompleted: requestedHealthStreamIds.size > 0 &&
            [...requestedHealthStreamIds].every((streamId) => unknownHealthStreamIds.has(streamId)),
        }), (value) => value.responses > 0 && value.allRequestedStreamsCompleted &&
          value.connections.length > 0 &&
          value.connections.every(({state: itemState}) => itemState === "unknown") &&
          value.faults.every((fault) => fault.count === 1 && fault.state === "unknown"), {
          timeoutMs: 45_000,
          intervalMs: 1_000,
          description: `${this.config.testLaneLabel} dashboard indicators to transition to Unknown after a completed empty reconciliation`,
        });
        const connectionLabelsCorrect = state.connections.every(({label}) => /unknown/i.test(label));
        const faultLabelsCorrect = state.faults.every(({kind, label}) =>
          label === `${DASHBOARD_FAULT_LABELS[kind]}: Unknown`);
        const passed = state.responses > 0 && state.allRequestedStreamsCompleted &&
          connectionLabelsCorrect && faultLabelsCorrect;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-health-unknown-fixture");
        return {
          passed,
          observed: `connections=${state.connections.length}; faults=${state.faults.length}; empty responses=${state.responses}; all requested streams completed=${state.allRequestedStreamsCompleted}; exact accessible labels=${connectionLabelsCorrect && faultLabelsCorrect}`,
          evidence,
        };
      });

      fixtureMode = "live";
      await page.reload({waitUntil: "domcontentloaded"});
      await card.waitFor({timeout: this.config.uiTimeoutMs});
      await this.check({
        scenario: "dashboard-health", category: "dashboard-health", action: "recover live dashboard health after fixtures",
        target: "Dashboard Lane Status", expected: "every RPM and camera returns Online and all five reserved-lane fault indicators resolve Clear",
      }, async () => {
        const indicators = page.locator('[data-testid^="lane-health-"][data-testid$="-rpm"], [data-testid^="lane-health-"][data-testid$="-camera"]');
        const expected = this.config.expectedLaneCount + this.config.expectedCameraCount;
        const recovered = await poll(async () => ({
          connections: await indicators.evaluateAll((nodes) => nodes.map((node) => ({
            state: node.getAttribute("data-state"), label: node.getAttribute("aria-label") ?? "",
          }))),
          faultCounts: await Promise.all(DASHBOARD_FAULT_KINDS.map((kind) => this.dashboardFault(page, kind).count())),
        }), (value) => value.connections.length === expected &&
          value.connections.every(({state, label}) => state === "online" && /online/i.test(label)) &&
          value.faultCounts.every((count) => count === 0), {
          timeoutMs: 45_000,
          intervalMs: 1_000,
          description: "dashboard live connection and clear fault state to recover after fixtures",
        });
        const passed = recovered.connections.length === expected &&
          recovered.connections.every(({state, label}) => state === "online" && /online/i.test(label)) &&
          recovered.faultCounts.every((count) => count === 0);
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-health-live-recovery");
        return {
          passed,
          observed: `Online connections=${recovered.connections.length}/${expected}; reserved-lane remaining fault indicators=${recovered.faultCounts.reduce((sum, count) => sum + count, 0)}`,
          evidence,
        };
      });
      await this.check({
        scenario: "dashboard-health", category: "navigation", action: "open lane details from compact health card",
        target: this.config.testLaneLabel, expected: "keyboard activation of the lane health card opens that lane's detail page",
      }, async () => {
        const link = this.dashboardCard(page).getByRole("link");
        await link.focus();
        await page.keyboard.press("Enter");
        await page.waitForURL(
          (url) => normalizePathname(url.pathname) === "/lane-view",
          {timeout: this.config.uiTimeoutMs},
        );
        const heading = await page.getByText(`Lane ID: ${this.config.testLaneLabel}`, {exact: true})
          .isVisible().catch(() => false);
        const evidence = heading ? "" : await this.screenshotOnFailure(page, "dashboard-health-lane-navigation");
        return {passed: heading, observed: `URL=${page.url()}; expected lane heading visible=${heading}`, evidence};
      });
    } finally {
      probeEnabled = false;
      page.off("request", requestStarted);
      page.off("requestfinished", requestSettled);
      page.off("requestfailed", requestSettled);
      await page.unroute(healthRoutePattern).catch(() => undefined);
      await page.close();
    }
  }

  private async laneVideo(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      await this.goto(page, "/");
      const laneSection = page.getByText("Lane Status", {exact: true}).locator("xpath=ancestor::*[contains(@class,'MuiStack-root')][1]");
      const laneLabel = laneSection.getByText(this.config.testLaneLabel, {exact: true});
      await laneLabel.first().waitFor({timeout: this.config.uiTimeoutMs});
      if (await laneLabel.count() !== 1) {
        throw new Error(`Expected exactly one dashboard card for ${this.config.testLaneLabel}`);
      }
      await laneLabel.click();
      await page.waitForURL(/\/lane-view/);
      await this.check({
        scenario: "lane-video", category: "video", action: "render lane detail telemetry",
        target: this.config.testLaneLabel, expected: "lane heading, gamma chart, neutron chart, and event table visible",
      }, async () => {
        const heading = await page.getByText(`Lane ID: ${this.config.testLaneLabel}`, {exact: true})
          .isVisible().catch(() => false);
        const gamma = await isVisible(page.locator("#chart-view-gamma"));
        const neutron = await isVisible(page.locator("#chart-view-neutron"));
        const table = await page.locator(".MuiDataGrid-root").count() > 0;
        const passed = heading && gamma && neutron && table;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "lane-detail-components");
        return {passed, observed: `heading=${heading}; gamma=${gamma}; neutron=${neutron}; table=${table}`, evidence};
      });
      await this.check({
        scenario: "lane-video", category: "video", action: "play live camera video",
        target: this.config.testLaneLabel, expected: "video reaches readyState >= 2 with non-zero dimensions within 60 seconds",
      }, async () => {
        const video = page.locator("video").first();
        await video.waitFor({timeout: 60_000});
        await page.waitForFunction(() => {
          const element = document.querySelector("video") as HTMLVideoElement | null;
          return Boolean(element && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0);
        }, undefined, {timeout: 60_000});
        const state = await video.evaluate((element: HTMLVideoElement) => ({
          readyState: element.readyState,
          width: element.videoWidth,
          height: element.videoHeight,
          paused: element.paused,
          currentTime: element.currentTime,
        }));
        await page.waitForTimeout(2_000);
        const laterTime = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
        const advanced = laterTime > state.currentTime;
        return {
          passed: state.readyState >= 2 && state.width > 0 && state.height > 0 && advanced,
          observed: `readyState=${state.readyState}; ${state.width}x${state.height}; paused=${state.paused}; advanced=${advanced}`,
        };
      });
    } finally { await page.close(); }
  }

  private async eventFiltering(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      await this.goto(page, "/event-log");
      await page.locator(".MuiDataGrid-root").waitFor();
      await this.check({
        scenario: "event-filtering", category: "events", action: "load paginated event data",
        target: "Event Log", expected: "at least one event row loads",
      }, async () => {
        const rows = page.locator(".MuiDataGrid-row");
        await rows.first().waitFor({timeout: this.config.eventTimeoutMs});
        const count = await rows.count();
        return {passed: count > 0, observed: `${count} visible rows`};
      });
      await this.check({
        scenario: "event-filtering", category: "events", action: "apply full-database lane filter",
        target: "Event Log Advanced filters", expected: `server-side filter returns only ${this.config.testLaneLabel} rows`,
      }, async () => {
        await this.applyLaneEventFilter(page);
        let texts: string[];
        try {
          texts = await poll(
            () => page.locator(".MuiDataGrid-row").allInnerTexts(),
            (values) => values.length > 0 && values.every((value) => value.includes(this.config.testLaneLabel)),
            {timeoutMs: 30_000, intervalMs: 500, description: `filtered rows for ${this.config.testLaneLabel}`},
          );
        } catch (error) {
          const evidence = await this.screenshotOnFailure(page, "event-filter-lane-mismatch");
          this.reporter.error("event-filtering", "apply full-database lane filter", error, evidence);
          return {
            passed: false,
            observed: `filter did not converge: ${describeError(error)}`,
            evidence,
          };
        }
        return {
          passed: texts.length > 0 && texts.every((text) => text.includes(this.config.testLaneLabel)),
          observed: `${texts.length} visible rows; all match lane=${texts.every((text) => text.includes(this.config.testLaneLabel))}`,
        };
      });
    } finally { await page.close(); }
  }

  private async applyLaneEventFilter(page: Page): Promise<void> {
    await page.getByRole("button", {name: /advanced filters/i}).first().click();
    const dialog = page.getByRole("dialog", {name: /advanced filters/i});
    await dialog.waitFor();
    await dialog.getByRole("button", {name: /add condition/i}).click();
    const boxes = dialog.getByRole("combobox");
    await boxes.nth(1).click();
    await page.getByRole("option", {name: "Lane ID", exact: true}).click();
    await poll(
      () => boxes.nth(1).innerText(),
      (value) => value.trim() === "Lane ID",
      {timeoutMs: this.config.uiTimeoutMs, intervalMs: 100, description: "lane filter field selection"},
    );
    await boxes.nth(3).click();
    await page.getByRole("option", {name: this.config.testLaneLabel, exact: true}).click();
    await poll(
      () => boxes.nth(3).innerText(),
      (value) => value.trim() === this.config.testLaneLabel,
      {timeoutMs: this.config.uiTimeoutMs, intervalMs: 100, description: "lane filter value selection"},
    );
    await dialog.getByRole("button", {name: /apply filters/i}).click();
    await dialog.waitFor({state: "hidden"});
  }

  private async operationalViews(): Promise<void> {
    const workflowMetadata: CheckMetadata = {
      scenario: "operational-views", category: "scope", action: "detect operational-view workflow",
      target: this.config.oscarLaneConfigPath,
      expected: "Viewer supports fail-closed operational-view scoping",
    };
    if (this.config.operationalViewWorkflow === "disabled") {
      this.skip(workflowMetadata, "OPERATIONAL_VIEW_WORKFLOW is disabled");
      return;
    }
    const oracle = this.config.laneConfigOracle;
    if (!oracle) {
      this.reporter.outcome(
        workflowMetadata.scenario, workflowMetadata.category, workflowMetadata.action,
        workflowMetadata.target, workflowMetadata.expected,
        "lane membership oracle is unavailable", "incorrect", 0,
      );
      return;
    }
    const configuredViewKeys = this.config.operationalViewWorkflow === "required"
      ? [...REQUIRED_OPERATIONAL_VIEW_KEYS]
      : [...oracle.lanesByView.keys()].sort();

    const page = await this.browser.oscarPage();
    try {
      const firstKey = configuredViewKeys[0] ?? "east-gate";
      await this.goto(page, `/?view=${firstKey}`);
      const capabilityAvailable = await page.getByText(`View: ${firstKey}`, {exact: true})
        .waitFor({timeout: this.config.uiTimeoutMs})
        .then(() => true, () => false);
      if (!capabilityAvailable) {
        if (this.config.operationalViewWorkflow === "auto") {
          this.skip(workflowMetadata, "operational-view workflow is not present on this build (auto detection)");
        } else {
          this.reporter.outcome(
            workflowMetadata.scenario, workflowMetadata.category, workflowMetadata.action,
            workflowMetadata.target, workflowMetadata.expected,
            "operational-view chip did not appear", "incorrect", 0,
          );
        }
        return;
      }
      if (!configuredViewKeys.length) {
        this.reporter.outcome(
          workflowMetadata.scenario, workflowMetadata.category, workflowMetadata.action,
          workflowMetadata.target, workflowMetadata.expected,
          "lane membership oracle contains no operational-view assignments", "incorrect", 0,
        );
        return;
      }
      this.reporter.outcome(
        workflowMetadata.scenario, workflowMetadata.category, workflowMetadata.action,
        workflowMetadata.target, workflowMetadata.expected,
        "operational-view chip is available", "correct", 0,
      );

      const invalidKey = `unassigned-${randomUUID().slice(0, 12)}`;
      await this.check({
        scenario: "operational-views", category: "scope", action: "reject an unassigned operational view",
        target: invalidKey, expected: "Viewer fails closed and loads no lane data for an unassigned view key",
      }, async () => {
        await this.goto(page, `/health?view=${encodeURIComponent(invalidKey)}`);
        const empty = page.getByText(new RegExp(`No lanes are assigned to operational view.*${invalidKey}`, "i"));
        await empty.waitFor({timeout: this.config.uiTimeoutMs});
        const rows = await page.locator('[data-testid^="health-lane-"]').count();
        return {passed: rows === 0, observed: `empty-view warning visible; health rows=${rows}`};
      });

      for (const [action, search] of [
        ["reject an invalid operational-view key", "?view=North_Gate"],
        ["reject duplicate operational-view parameters", "?view=east-gate&view=west-gate"],
      ] as const) {
        await this.check({
          scenario: "operational-views", category: "scope", action,
          target: search, expected: "malformed view selection fails closed with no loaded lane data",
        }, async () => {
          await this.goto(page, `/health${search}`);
          await page.getByText("This operational-view URL is invalid. No lanes have been loaded.", {exact: true})
            .waitFor({timeout: this.config.uiTimeoutMs});
          const rows = await page.locator('[data-testid^="health-lane-"]').count();
          return {passed: rows === 0, observed: `invalid-view warning visible; health rows=${rows}`};
        });
      }

      for (const key of configuredViewKeys) {
        const fixtureLaneNames = oracle.lanesByView.get(key) ?? [];
        const expectedLaneNames = [...fixtureLaneNames].sort((a, b) => a.localeCompare(b));
        await this.check({
          scenario: "operational-views", category: "scope", action: `scope ${key} operational view`,
          target: key,
          expected: `Dashboard cards and Status of Health retain view=${key} and list exactly ${expectedLaneNames.join(";")}`,
        }, async () => {
          await this.goto(page, `/?view=${encodeURIComponent(key)}`);
          await page.getByText(`View: ${key}`, {exact: true}).waitFor({timeout: this.config.uiTimeoutMs});

          const dashboardCards = page.locator('[data-testid^="lane-health-card-"]');
          const readDashboardCards = async () => (await dashboardCards.evaluateAll((elements) => elements.map((element) => ({
            laneName: (element.getAttribute("data-testid") ?? "").replace(/^lane-health-card-/, ""),
            rpmCount: element.querySelectorAll('[data-testid$="-rpm"]').length,
            cameraCount: element.querySelectorAll('[data-testid$="-camera"]').length,
            cameraIds: [...element.querySelectorAll('[data-testid$="-camera"]')]
              .map((camera) => camera.getAttribute("data-component-id") ?? "")
              .filter(Boolean),
          })))).sort((a, b) => a.laneName.localeCompare(b.laneName));
          const requireOneCameraPerLane = this.config.expectedCameraCount === this.config.expectedLaneCount;
          let dashboardState: Array<{
            laneName: string;
            rpmCount: number;
            cameraCount: number;
            cameraIds: string[];
          }>;
          try {
            dashboardState = await poll(
              readDashboardCards,
              (value) => {
                const laneNames = value.map(({laneName}) => laneName);
                const cameraIds = value.flatMap(({cameraIds}) => cameraIds);
                const renderedCameraCount = value.reduce((sum, {cameraCount}) => sum + cameraCount, 0);
                return laneNames.length === expectedLaneNames.length &&
                  laneNames.every((laneName, index) => laneName === expectedLaneNames[index]) &&
                  value.every(({rpmCount}) => rpmCount === 1) &&
                  (!requireOneCameraPerLane || value.every(({cameraCount}) => cameraCount === 1)) &&
                  cameraIds.length === renderedCameraCount &&
                  new Set(cameraIds).size === cameraIds.length;
              },
              {
                timeoutMs: this.config.uiTimeoutMs,
                intervalMs: 250,
                description: `exact ${key} Dashboard lane and component membership`,
              },
            );
          } catch {
            dashboardState = await readDashboardCards();
            const evidence = await this.screenshotOnFailure(page, `operational-view-${safeName(key)}-dashboard-membership`);
            return {
              passed: false,
              observed: `Dashboard lanes=${dashboardState.map(({laneName}) => laneName).join(";") || "none"}; RPM mappings=${dashboardState.map(({laneName, rpmCount}) => `${laneName}:${rpmCount}`).join("|") || "none"}; camera mappings=${dashboardState.map(({laneName, cameraCount}) => `${laneName}:${cameraCount}`).join("|") || "none"}`,
              evidence,
            };
          }

          const healthLink = page.locator(`a[href="/health/?view=${encodeURIComponent(key)}"]`).first();
          await healthLink.waitFor({timeout: this.config.uiTimeoutMs});
          const href = await healthLink.getAttribute("href");
          await Promise.all([
            page.waitForURL((url) =>
              normalizePathname(url.pathname) === "/health" &&
              url.searchParams.getAll("view").length === 1 &&
              url.searchParams.get("view") === key,
            {timeout: this.config.uiTimeoutMs}),
            healthLink.click(),
          ]);
          await page.getByRole("heading", {name: "Status of Health", exact: true})
            .waitFor({timeout: this.config.uiTimeoutMs});
          await page.getByText(`View: ${key}`, {exact: true}).waitFor({timeout: this.config.uiTimeoutMs});

          const rows = page.locator('[data-testid^="health-lane-"]');
          const readLaneNames = async () => (await rows.evaluateAll((elements) => elements
            .map((element) => element.getAttribute("data-testid")?.replace(/^health-lane-/, "") ?? "")
            .filter(Boolean))).sort();
          let actualLaneNames: string[] = [];
          try {
            actualLaneNames = await poll(
              readLaneNames,
              (value) => value.length === expectedLaneNames.length &&
                value.every((laneName, index) => laneName === expectedLaneNames[index]),
              {
                timeoutMs: this.config.uiTimeoutMs,
                intervalMs: 250,
                description: `exact ${key} Status of Health lane membership`,
              },
            );
          } catch {
            actualLaneNames = await readLaneNames();
            const evidence = await this.screenshotOnFailure(page, `operational-view-${safeName(key)}-membership`);
            return {
              passed: false,
              observed: `nav href=${href}; lanes=${actualLaneNames.join(";") || "none"}`,
              evidence,
            };
          }
          const current = new URL(page.url());
          const queryPersisted = current.searchParams.getAll("view").length === 1 &&
            current.searchParams.get("view") === key;
          return {
            passed: href === `/health/?view=${encodeURIComponent(key)}` && queryPersisted,
            observed: `Dashboard exact lanes=${dashboardState.length}; one RPM per lane=true; canonical one camera per lane=${requireOneCameraPerLane}; nav href=${href}; query persisted=${queryPersisted}; Health exact lanes=${actualLaneNames.length}`,
          };
        });
      }
    } finally { await page.close(); }
  }

  private async selectMui(page: Page, label: string, value?: string): Promise<void> {
    const labelLocator = page.locator("label").filter({hasText: label}).first();
    await labelLocator.waitFor();
    await labelLocator.locator("xpath=..").locator(".MuiSelect-select").click();
    const options = page.locator(".MuiList-root .MuiMenuItem-root:visible");
    await options.first().waitFor();
    if (value) {
      const exact = page.locator(`.MuiList-root .MuiMenuItem-root[data-value="${value}"]:visible`);
      if (await exact.count()) await exact.first().click();
      else await options.filter({hasText: value}).first().click();
    } else {
      await options.filter({hasNot: page.locator('[data-value="all"]')}).first().click();
    }
  }

  private async generateReport(page: Page, reportCase: ReportCase): Promise<{src: string; saved: string; pages: number}> {
    const {reportType, eventType} = reportCase;
    await this.goto(page, "/report");
    await page.getByRole("heading", {name: "Report Generator", exact: true}).waitFor();
    await this.selectMui(page, "Node Selector");
    if (["LANE", "ADJUDICATION"].includes(reportType)) {
      await this.selectMui(page, "Report Scope", "LANES");
      const laneLabel = page.getByText("Lane Selector", {exact: true}).first();
      await laneLabel.locator("xpath=..").locator(".MuiSelect-select").click();
      const laneOption = page.locator(".MuiList-root .MuiMenuItem-root:visible")
        .filter({hasText: this.config.testLaneLabel}).first();
      await laneOption.waitFor();
      await laneOption.click();
      await page.keyboard.press("Escape");
    }
    await this.selectMui(page, "Report Type", reportType);
    if (reportType === "EVENT") await this.selectMui(page, "Event Type", eventType ?? "ALARMS_OCCUPANCIES");
    await this.selectMui(page, "Time Range", "last24Hrs");
    const button = page.getByRole("button", {name: "Generate Report"});
    await button.click();
    const iframe = page.locator("iframe").first();
    const outcome = await poll(async () => {
      const src = await iframe.getAttribute("src").catch(() => null);
      if (src?.includes(".pdf")) return {src, error: ""};
      const body = await page.locator("body").innerText();
      const failure = body.match(/report (?:generation|request) failed[^\n]*/i)?.[0] ?? "";
      return failure ? {src: "", error: failure} : null;
    }, (value): value is {src: string; error: string} => value !== null, {
      timeoutMs: this.config.eventTimeoutMs,
      intervalMs: 1_000,
      description: `${reportType} report completion`,
    });
    if (!outcome) throw new Error(`${reportType} report did not return an outcome`);
    if (outcome.error) throw new Error(outcome.error);
    const src = outcome.src;
    if (!src) throw new Error(`${reportType} report iframe has no src`);
    const response = await page.context().request.get(new URL(src, this.config.oscarBaseUrl).toString());
    if (!response.ok()) throw new Error(`${reportType} report download returned ${response.status()}`);
    const body = await response.body();
    if (body.subarray(0, 4).toString() !== "%PDF") throw new Error(`${reportType} report is not a PDF`);
    const parser = new PDFParse({data: body});
    let parsed;
    try {
      parsed = await parser.getText();
    } finally {
      await parser.destroy();
    }
    const text = parsed.text.replaceAll(/\s+/g, " ");
    const expectedTitle = reportType === "RDS_SITE" ? "RDS Site Report"
      : reportType === "LANE" ? "Lane Report"
        : reportType === "ADJUDICATION" ? "Adjudication Report" : "Event Report";
    const laneNumber = this.config.testLaneLabel.match(/\d+/)?.[0] ?? "";
    const expectedLane = ["LANE", "ADJUDICATION"].includes(reportType) && laneNumber
      ? new RegExp(`lane-\\s*0*${Number(laneNumber)}\\b`, "i").test(text)
      : true;
    const expectedEvent = reportType === "EVENT"
      ? text.includes(`Event Type: ${eventType}`)
      : true;
    if (parsed.total < 1 || text.length < 80 || !text.includes(expectedTitle) || !expectedLane || !expectedEvent) {
      throw new Error(
        `${reportType} PDF semantic validation failed: pages=${parsed.total}; title=${text.includes(expectedTitle)}; lane=${expectedLane}; event=${expectedEvent}`,
      );
    }
    const qualifier = eventType ? `-${eventType.toLowerCase()}` : "";
    const saved = join(this.reporter.downloadDir, `${reportType.toLowerCase()}${qualifier}-report.pdf`);
    writeFileSync(saved, body);
    return {src, saved: join("downloads", basename(saved)), pages: parsed.total};
  }

  private async reporting(cases: ReportCase[]): Promise<void> {
    for (const reportCase of cases) {
      const page = await this.browser.oscarPage();
      try {
        const {reportType, eventType} = reportCase;
        const label = eventType ? `${reportType}/${eventType}` : reportType;
        await this.check({
          scenario: reportType === "ADJUDICATION" ? "adjudication-report" : "reporting",
          category: "reports",
          action: `generate ${label} report`,
          target: "Report Generator",
          expected: "Viewer generates and downloads a valid PDF for the last 24 hours",
        }, async () => {
          const result = await this.generateReport(page, reportCase);
          return {
            passed: true,
            observed: `valid ${result.pages}-page PDF with expected report semantics from ${result.src}`,
            evidence: result.saved,
          };
        });
      } finally { await page.close(); }
    }
  }

  private async alarmTransferValidation(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      await this.goto(page, "/alarm-transfer");
      await this.check({
        scenario: "alarm-transfer", category: "alarm-transfer", action: "reject invalid offline alarm payload",
        target: "Alarm Transfer", expected: "invalid payload is rejected with a visible error and no imported record",
      }, async () => {
        const field = page.getByLabel("Paste OSCAR alarm QR payload");
        await field.fill(`not-an-oscar-alarm-${this.reporter.runId}`);
        await page.getByRole("button", {name: /decode payload/i}).click();
        const texts = await poll(
          () => page.getByRole("alert").allInnerTexts(),
          (values) => values.some((value) => /could not be opened/i.test(value)),
          {timeoutMs: 10_000, intervalMs: 250, description: "invalid alarm payload error"},
        );
        const text = texts.find((value) => /could not be opened/i.test(value)) ?? "";
        return {passed: Boolean(text), observed: text};
      });
    } finally { await page.close(); }
  }

  private async alarmTransferCamera(): Promise<void> {
    const capability: CheckMetadata = {
      scenario: "alarm-transfer-camera",
      category: "alarm-transfer",
      action: "detect camera QR workflow",
      target: "Alarm Transfer",
      expected: "camera and QR-image scan controls are available",
    };
    if (this.config.alarmTransferCameraWorkflow === "disabled") {
      this.skip(capability, "ALARM_TRANSFER_CAMERA_WORKFLOW=disabled");
      return;
    }

    const fixture = this.browser.alarmTransferCameraFixture();
    if (!fixture) throw new Error("Deterministic Alarm Transfer camera fixture was not installed");
    const page = await this.browser.oscarPage();
    try {
      await this.goto(page, "/alarm-transfer");
      const importField = page.getByLabel("Paste OSCAR alarm QR payload", {exact: true});
      const importUiReady = await importField.waitFor({
        state: "visible",
        timeout: this.config.uiTimeoutMs,
      }).then(() => true, () => false);
      if (!importUiReady) {
        const evidence = await this.screenshotOnFailure(page, "alarm-transfer-camera-import-ui-not-ready");
        this.reporter.outcome(
          capability.scenario, capability.category, capability.action, capability.target,
          capability.expected,
          "Alarm Transfer import UI did not become ready before camera capability detection",
          "incorrect", 0, evidence,
        );
        return;
      }
      const startButton = page.getByRole("button", {name: /start camera scan/i});
      const imageButton = page.getByRole("button", {name: /scan qr image/i});
      const [startControlPresent, imageControlPresent] = await Promise.all([
        startButton.count().then((count) => count > 0),
        imageButton.count().then((count) => count > 0),
      ]);
      if (!startControlPresent || !imageControlPresent) {
        if (this.config.alarmTransferCameraWorkflow === "auto" &&
            !startControlPresent && !imageControlPresent) {
          this.skip(capability, "camera QR workflow is not present on this build (auto detection)");
        } else {
          const observed = !startControlPresent && !imageControlPresent
            ? "camera and QR-image scan controls are both absent"
            : `partial camera workflow: start control=${startControlPresent}; ` +
              `QR-image control=${imageControlPresent}`;
          const evidence = await this.screenshotOnFailure(page, "alarm-transfer-camera-capability-missing");
          this.reporter.outcome(
            capability.scenario, capability.category, capability.action, capability.target,
            capability.expected,
            observed, "incorrect", 0, evidence,
          );
        }
        return;
      }
      // Fail closed before any scanner click so a broken init script can never
      // fall through to a runner's physical camera.
      await this.browser.assertAlarmTransferCameraFacade(page);
      this.reporter.outcome(
        capability.scenario, capability.category, capability.action, capability.target,
        capability.expected,
        `controls detected; fixture QR version=${fixture.qrVersion}; transport=${fixture.transportCharacters} characters; ` +
          `symbol=${fixture.symbolPixels}px at ${fixture.pixelsPerModule}px/module`,
        "correct", 0,
      );

      const cameraStarted = await this.check({
        scenario: "alarm-transfer-camera", category: "camera", action: "start deterministic camera preview",
        target: "Alarm Transfer camera",
        expected: "camera starts with a visible, non-zero preview and a contained non-zero scan overlay",
      }, async () => {
        await startButton.click();
        await page.getByRole("button", {name: /stop camera scan/i}).waitFor({timeout: this.config.uiTimeoutMs});
        const preview = page.getByTestId("alarm-qr-camera-preview");
        const video = page.getByTestId("alarm-qr-camera-video");
        const overlay = preview.locator(".scan-region-highlight").first();
        const status = page.getByTestId("alarm-qr-camera-status");
        const activeCamera = page.getByTestId("alarm-qr-active-camera");
        await preview.waitFor({state: "visible", timeout: this.config.uiTimeoutMs});
        await overlay.waitFor({state: "visible", timeout: this.config.uiTimeoutMs});
        await page.waitForFunction(() => {
          const element = document.querySelector('[data-testid="alarm-qr-camera-video"]') as
            HTMLVideoElement | null;
          return Boolean(element && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0);
        }, undefined, {timeout: this.config.uiTimeoutMs});
        const dimensions = await video.evaluate((element: HTMLVideoElement) => ({
          readyState: element.readyState,
          videoWidth: element.videoWidth,
          videoHeight: element.videoHeight,
          renderedWidth: element.getBoundingClientRect().width,
          renderedHeight: element.getBoundingClientRect().height,
        }));
        const previewBox = await preview.boundingBox();
        const overlayBox = await overlay.boundingBox();
        const visibleContentHeight = Math.min(
          dimensions.renderedHeight,
          dimensions.renderedWidth * dimensions.videoHeight / dimensions.videoWidth,
        );
        const overlayRatio = overlayBox && visibleContentHeight > 0
          ? overlayBox.height / visibleContentHeight
          : 0;
        const tolerance = 2;
        const overlayContained = Boolean(previewBox && overlayBox && overlayBox.width > 0 && overlayBox.height > 0 &&
          overlayBox.x >= previewBox.x - tolerance && overlayBox.y >= previewBox.y - tolerance &&
          overlayBox.x + overlayBox.width <= previewBox.x + previewBox.width + tolerance &&
          overlayBox.y + overlayBox.height <= previewBox.y + previewBox.height + tolerance);
        const overlayCoverage = overlayRatio > 0.8 && overlayRatio <= 1.01;
        const statusText = await poll(
          () => status.innerText().then((value) => value.trim()).catch(() => ""),
          (value) => /\bScanning\b/.test(value),
          {timeoutMs: this.config.uiTimeoutMs, intervalMs: 100, description: "visible camera Scanning status"},
        );
        const activeCameraText = await poll(
          () => activeCamera.innerText().catch(() => ""),
          (value) => /OSCAR deterministic QR camera/i.test(value) && /640\s*[×x]\s*480/.test(value),
          {timeoutMs: this.config.uiTimeoutMs, intervalMs: 100, description: "active camera identity and resolution"},
        );
        const statusScanning = await status.isVisible() && /\bScanning\b/.test(statusText);
        const activeCameraVisible = await activeCamera.isVisible() &&
          /OSCAR deterministic QR camera/i.test(activeCameraText) && /640\s*[×x]\s*480/.test(activeCameraText);
        const state = await this.browser.alarmTransferCameraState(page);
        const visible = await video.isVisible();
        const passed = visible && dimensions.readyState >= 2 && dimensions.videoWidth > 0 &&
          dimensions.videoHeight > 0 && dimensions.renderedWidth > 0 && dimensions.renderedHeight > 0 &&
          overlayContained && overlayCoverage && statusScanning && activeCameraVisible &&
          state.requestCount > 0 && state.activeTrackCount > 0 && state.previewFrameRendered;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "alarm-transfer-camera-preview");
        return {
          passed,
          observed: `visible=${visible}; video=${dimensions.videoWidth}x${dimensions.videoHeight}; ` +
            `rendered=${Math.round(dimensions.renderedWidth)}x${Math.round(dimensions.renderedHeight)}; ` +
            `overlay=${overlayBox ? `${Math.round(overlayBox.width)}x${Math.round(overlayBox.height)}` : "missing"}; ` +
            `overlay/content ratio=${overlayRatio.toFixed(3)}; overlay contained=${overlayContained}; ` +
            `status=${JSON.stringify(statusText)}; active camera=${JSON.stringify(activeCameraText)}; ` +
            `active tracks=${state.activeTrackCount}`,
          value: passed ? true : undefined,
          evidence,
        };
      });
      if (!cameraStarted) return;

      await this.browser.renderAlarmTransferCameraQr(page);
      const decoded = await this.check({
        scenario: "alarm-transfer-camera", category: "alarm-transfer", action: "decode dense camera QR",
        target: fixture.observationId,
        expected: "the version-23 camera QR passes integrity validation and preserves its occupancy UUID",
      }, async () => {
        await page.getByText("The alarm data passed its SHA-256 integrity check.", {exact: true})
          .waitFor({timeout: this.config.eventTimeoutMs});
        const body = await page.locator("body").innerText();
        const uuid = page.getByTestId("alarm-transfer-import-uuid");
        const displayedUuid = await uuid.count() ? (await uuid.innerText()).trim() : "";
        const integrityVisible = body.includes("The alarm data passed its SHA-256 integrity check.");
        const uuidMatches = displayedUuid
          ? displayedUuid === fixture.observationId
          : body.includes(fixture.observationId);
        const identityVisible = body.includes(fixture.occupancyId) && body.includes(fixture.laneId);
        const state = await this.browser.alarmTransferCameraState(page);
        const passed = integrityVisible && uuidMatches && identityVisible && state.qrFrameRendered &&
          state.requestedFrameCount > 0;
        const evidence = await this.browser.screenshot(page, "alarm-transfer-camera-decoded");
        return {
          passed,
          observed: `QR version=${fixture.qrVersion}; transport=${fixture.transportCharacters} characters; ` +
            `symbol=${fixture.symbolPixels}px; integrity=${integrityVisible}; UUID matches=${uuidMatches}; ` +
            `fixture identity=${identityVisible}; requested QR frames=${state.requestedFrameCount}`,
          value: passed ? true : undefined,
          evidence,
        };
      });
      if (!decoded) return;

      await this.check({
        scenario: "alarm-transfer-camera", category: "camera", action: "release camera after decode",
        target: "Alarm Transfer camera track",
        expected: "successful decode stops every created camera track",
      }, async () => {
        const state = await poll(
          () => this.browser.alarmTransferCameraState(page),
          (value) => value.createdTrackCount > 0 && value.activeTrackCount === 0 &&
            value.stoppedTrackCount === value.createdTrackCount,
          {timeoutMs: 10_000, intervalMs: 100, description: "Alarm Transfer camera tracks to stop"},
        );
        const passed = state.activeTrackCount === 0 && state.createdTrackCount === state.stoppedTrackCount;
        return {
          passed,
          observed: `created=${state.createdTrackCount}; stopped=${state.stoppedTrackCount}; active=${state.activeTrackCount}`,
        };
      });

      await this.check({
        scenario: "alarm-transfer-camera", category: "error-handling",
        action: "report denied camera permission and retry",
        target: "Alarm Transfer camera",
        expected: "denied permission is shown, retry starts a visible preview, and stopping releases every track",
      }, async () => {
        await page.getByRole("button", {name: /scan another alarm/i}).click();
        await startButton.waitFor({timeout: this.config.uiTimeoutMs});
        await this.browser.rejectAlarmTransferCameraRequests(page);
        const deniedPermission = await page.evaluate(async () =>
          (await navigator.permissions.query({name: "camera" as PermissionName})).state);
        await startButton.click();
        const alerts = await poll(
          () => page.getByRole("alert").allInnerTexts(),
          (values) => values.some((value) =>
            /camera permission was denied/i.test(value) && /browser settings/i.test(value)),
          {timeoutMs: this.config.uiTimeoutMs, intervalMs: 100, description: "actionable camera permission alert"},
        );
        const deniedState = await this.browser.alarmTransferCameraState(page);
        const errorText = alerts.find((value) =>
          /camera permission was denied/i.test(value) && /browser settings/i.test(value)) ?? "";
        const deniedCleanly = deniedPermission === "denied" && Boolean(errorText) &&
          deniedState.activeTrackCount === 0;

        await this.browser.allowAlarmTransferCameraRequests(page);
        const grantedPermission = await page.evaluate(async () =>
          (await navigator.permissions.query({name: "camera" as PermissionName})).state);
        await startButton.click();
        const stopButton = page.getByRole("button", {name: /stop camera scan/i});
        await stopButton.waitFor({timeout: this.config.uiTimeoutMs});
        const video = page.getByTestId("alarm-qr-camera-video");
        await page.waitForFunction(() => {
          const element = document.querySelector('[data-testid="alarm-qr-camera-video"]') as
            HTMLVideoElement | null;
          return Boolean(element && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0);
        }, undefined, {timeout: this.config.uiTimeoutMs});
        const retryPreview = await video.evaluate((element: HTMLVideoElement) => ({
          width: element.videoWidth,
          height: element.videoHeight,
          renderedWidth: element.getBoundingClientRect().width,
          renderedHeight: element.getBoundingClientRect().height,
        }));
        const retryState = await this.browser.alarmTransferCameraState(page);
        const retryStarted = await video.isVisible() && retryPreview.width > 0 && retryPreview.height > 0 &&
          retryPreview.renderedWidth > 0 && retryPreview.renderedHeight > 0 && retryState.activeTrackCount > 0;

        await stopButton.click();
        const finalState = await poll(
          () => this.browser.alarmTransferCameraState(page),
          (value) => value.createdTrackCount > 0 && value.activeTrackCount === 0 &&
            value.stoppedTrackCount === value.createdTrackCount,
          {timeoutMs: 10_000, intervalMs: 100, description: "retried camera tracks to stop"},
        );
        const cleanedUp = finalState.activeTrackCount === 0 &&
          finalState.stoppedTrackCount === finalState.createdTrackCount;
        const passed = deniedCleanly && grantedPermission === "granted" && retryStarted && cleanedUp;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "alarm-transfer-camera-error");
        return {
          passed,
          observed: `permission state=${deniedPermission}; feedback=${Boolean(errorText)}; ` +
            `rejected requests=${deniedState.rejectedRequestCount}; retry permission=${grantedPermission}; ` +
            `retry preview=${retryPreview.width}x${retryPreview.height}; ` +
            `created=${finalState.createdTrackCount}; stopped=${finalState.stoppedTrackCount}; active=${finalState.activeTrackCount}`,
          evidence,
        };
      });
    } finally {
      const stop = page.getByRole("button", {name: /stop camera scan/i});
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => undefined);
      await page.close();
    }
  }

  private async prepareReservedLane(): Promise<void> {
    await this.scenario("reserved-lane-setup", async () => {
      const rpm = await this.emulator.get(this.config.testRpmId);
      this.originalRpmConfig = structuredClone(rpm.config);
      this.originalRpmRunning = rpm.running;
      this.originalRpmStatus = rpm.running
        ? await this.emulator.statusOrNull(this.config.testRpmId)
        : null;
      this.reporter.addMetadata({
        reservedRpmConfigSha256: createHash("sha256")
          .update(JSON.stringify(this.originalRpmConfig))
          .digest("hex"),
      });
      writeFileSync(
        join(this.reporter.evidenceDir, "reserved-rpm-original-config.json"),
        `${JSON.stringify(this.originalRpmConfig, null, 2)}\n`,
      );
      writeFileSync(
        join(this.reporter.evidenceDir, "reserved-rpm-original-state.json"),
        `${JSON.stringify({
          running: this.originalRpmRunning,
          faults: this.originalRpmStatus ? {
            gammaHigh: this.originalRpmStatus.gh_fault,
            gammaLow: this.originalRpmStatus.gl_fault,
            neutronHigh: this.originalRpmStatus.nh_fault,
            tamper: this.originalRpmStatus.tamper_fault,
          } : null,
        }, null, 2)}\n`,
      );
      await this.emulator.clearFaults(this.config.testRpmId);
      await this.emulator.waitForIdle(this.config.testRpmId);
      await this.emulator.replaceConfig(this.config.testRpmId, this.emulator.quietConfig(rpm.config));
      this.reservedLanePrepared = true;
      const status = await this.emulator.waitForConnected(this.config.testRpmId);
      this.reporter.outcome(
        "reserved-lane-setup", "harness", "isolate reserved RPM", this.config.testRpmId,
        "automatic occupancies and alarms disabled; OSCAR client reconnected",
        `state=${status.state}; clients=${status.connected_clients}`, "correct", 0,
      );
    }, true);
    if (!this.reservedLanePrepared) throw new Error(`Could not prepare ${this.config.testRpmId}`);
  }

  private async restoreReservedLane(): Promise<void> {
    if (!this.originalRpmConfig) return;
    this.metrics.setPhase("reserved-lane-cleanup");
    this.browser.setScenario("reserved-lane-cleanup");
    try {
      const rpm = await this.emulator.get(this.config.testRpmId);
      if (!rpm.running) await this.emulator.start(this.config.testRpmId);
      await this.emulator.clearFaults(this.config.testRpmId);
      await this.emulator.replaceConfig(this.config.testRpmId, this.originalRpmConfig);
      if (this.originalRpmStatus) {
        for (const [type, active] of [
          ["gh", this.originalRpmStatus.gh_fault],
          ["gl", this.originalRpmStatus.gl_fault],
          ["nh", this.originalRpmStatus.nh_fault],
          ["tamper", this.originalRpmStatus.tamper_fault],
        ] as const) {
          if (active) await this.emulator.fault(this.config.testRpmId, type, true);
        }
      }
      if (this.originalRpmRunning === false) {
        await this.emulator.stop(this.config.testRpmId);
        await this.emulator.waitForStopped(this.config.testRpmId);
      }
      const restored = await this.emulator.get(this.config.testRpmId);
      const configMatches = JSON.stringify(restored.config) === JSON.stringify(this.originalRpmConfig);
      const runningMatches = restored.running === this.originalRpmRunning;
      const restoredStatus = restored.running ? await this.emulator.statusOrNull(this.config.testRpmId) : null;
      const faultsMatch = !this.originalRpmStatus || Boolean(restoredStatus &&
        restoredStatus.gh_fault === this.originalRpmStatus.gh_fault &&
        restoredStatus.gl_fault === this.originalRpmStatus.gl_fault &&
        restoredStatus.nh_fault === this.originalRpmStatus.nh_fault &&
        restoredStatus.tamper_fault === this.originalRpmStatus.tamper_fault);
      this.reporter.outcome(
        "reserved-lane-cleanup", "cleanup", "restore original RPM configuration", this.config.testRpmId,
        "exact original configuration, running state, and fault state restored",
        `configuration match=${configMatches}; running match=${runningMatches}; faults match=${faultsMatch}`,
        configMatches && runningMatches && faultsMatch ? "correct" : "incorrect", 0,
      );
    } catch (error) {
      this.reporter.outcome(
        "reserved-lane-cleanup", "cleanup", "restore original RPM configuration", this.config.testRpmId,
        "exact original configuration restored and RPM reconnected", "cleanup failed", "incorrect", 0, "", describeError(error),
      );
      this.reporter.error("reserved-lane-cleanup", "emulator", error);
    }
  }

  private async waitHealthText(page: Page, text: string, timeoutMs = 45_000): Promise<string> {
    await this.goto(page, "/health");
    const row = this.healthRow(page);
    await row.waitFor({timeout: timeoutMs});
    await poll(
      () => row.innerText(),
      (value) => value.toLowerCase().includes(text.toLowerCase()),
      {timeoutMs, intervalMs: 1_000, description: `${this.config.testLaneLabel} health to include ${text}`},
    );
    return row.innerText();
  }

  private async connectionFault(): Promise<void> {
    const page = await this.browser.oscarPage();
    let stopped = false;
    try {
      await this.emulator.stop(this.config.testRpmId);
      stopped = true;
      await this.emulator.waitForStopped(this.config.testRpmId);
      await this.check({
        scenario: "rpm-connection", category: "health", action: "detect RPM disconnection",
        target: this.config.testLaneLabel, expected: "Status of Health shows the reserved RPM Offline",
      }, async () => {
        const text = await this.waitHealthText(page, "Offline", 60_000);
        return {passed: /RPM.*Offline/i.test(text), observed: text};
      });
      await this.check({
        scenario: "rpm-connection", category: "dashboard-health", action: "show disconnected RPM independently on dashboard",
        target: this.config.testLaneLabel, expected: "dashboard RPM icon is Offline while every camera icon remains Online",
      }, async () => {
        const rpmCount = await this.waitDashboardConnectionState(page, "rpm", "offline", 60_000);
        const cameraCount = await this.waitDashboardConnectionState(page, "camera", "online", 60_000);
        const passed = rpmCount === 1 && cameraCount > 0;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-rpm-offline");
        return {
          passed,
          observed: `RPM Offline indicators=${rpmCount}; camera Online indicators=${cameraCount}`,
          evidence,
        };
      });
    } finally {
      if (stopped) {
        await this.emulator.start(this.config.testRpmId).catch(() => undefined);
        await this.emulator.waitForConnected(this.config.testRpmId);
      }
    }
    await this.check({
      scenario: "rpm-connection", category: "health", action: "detect RPM reconnection",
      target: this.config.testLaneLabel, expected: "Status of Health returns the reserved RPM to Online",
    }, async () => {
      const text = await this.waitHealthText(page, "Online", 60_000);
      return {passed: /RPM.*Online/i.test(text), observed: text};
    });
    await this.check({
      scenario: "rpm-connection", category: "dashboard-health", action: "show reconnected RPM on dashboard",
      target: this.config.testLaneLabel, expected: "dashboard RPM and every camera icon are Online after reconnection",
    }, async () => {
      const rpmCount = await this.waitDashboardConnectionState(page, "rpm", "online", 60_000);
      const cameraCount = await this.waitDashboardConnectionState(page, "camera", "online", 60_000);
      const passed = rpmCount === 1 && cameraCount > 0;
      const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-rpm-reconnected");
      return {
        passed,
        observed: `RPM Online indicators=${rpmCount}; camera Online indicators=${cameraCount}`,
        evidence,
      };
    });
    await page.close();
  }

  private faultFlag(status: RpmStatus, type: "gh" | "gl" | "nh" | "tamper"): boolean {
    if (type === "gh") return status.gh_fault;
    if (type === "gl") return status.gl_fault;
    if (type === "nh") return status.nh_fault;
    return status.tamper_fault;
  }

  private async faultViaApi(
    page: Page,
    type: "gh" | "gl" | "nh",
    label: string,
    dashboardKind: "gamma-high" | "gamma-low" | "neutron-high",
  ): Promise<void> {
    try {
      await this.emulator.waitForIdle(this.config.testRpmId);
      await this.emulator.fault(this.config.testRpmId, type, true);
      await this.emulator.waitForStatus(this.config.testRpmId, (status) => this.faultFlag(status, type), `${type} fault to assert`);
      await sleep(6_000);
      await this.check({
        scenario: "rpm-faults", category: "fault-detection", action: `detect ${label}`,
        target: this.config.testLaneLabel, expected: `${label}: Fault appears in Status of Health`,
      }, async () => {
        const text = await this.waitHealthText(page, `${label}: Fault`);
        return {passed: text.includes(`${label}: Fault`), observed: `${label}: Fault visible`};
      });
      await this.check({
        scenario: "rpm-faults", category: "dashboard-health", action: `show ${label} on dashboard`,
        target: this.config.testLaneLabel, expected: `${label} compact indicator is Active with an accessible fault label`,
      }, async () => {
        const count = await this.waitDashboardFaultState(page, dashboardKind, "active");
        const indicator = this.dashboardFault(page, dashboardKind);
        const labelText = await indicator.first().getAttribute("aria-label") ?? "";
        const passed = count === 1 && labelText === `${label}: Fault`;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, `dashboard-${dashboardKind}-active`);
        return {passed, observed: `active indicators=${count}; aria-label=${labelText}`, evidence};
      });
    } finally {
      await this.emulator.fault(this.config.testRpmId, type, false).catch((error) => this.reporter.error("rpm-faults", `clear-${type}`, error));
    }
    await this.emulator.waitForStatus(this.config.testRpmId, (status) => !this.faultFlag(status, type), `${type} fault to clear`);
    await sleep(6_000);
    await this.check({
      scenario: "rpm-faults", category: "fault-resolution", action: `resolve ${label}`,
      target: this.config.testLaneLabel, expected: `${label}: Clear appears in Status of Health`,
    }, async () => {
      const text = await this.waitHealthText(page, `${label}: Clear`);
      return {passed: text.includes(`${label}: Clear`), observed: `${label}: Clear visible`};
    });
    await this.check({
      scenario: "rpm-faults", category: "dashboard-health", action: `clear ${label} from dashboard`,
      target: this.config.testLaneLabel, expected: `${label} compact indicator disappears after the fault clears`,
    }, async () => {
      const count = await this.waitDashboardFaultState(page, dashboardKind, "clear");
      return {passed: count === 0, observed: `remaining indicators=${count}`};
    });
  }

  private async tamperViaEmulatorGui(page: Page): Promise<void> {
    const emulatorPage = await this.browser.emulatorPage();
    try {
      await emulatorPage.goto(this.config.rpmEmulatorUrl, {waitUntil: "domcontentloaded"});
      const card = emulatorPage.locator(`.rpm-card[data-id="${this.config.testRpmId}"]`);
      await card.waitFor();
      const tamper = card.locator('[data-action="tamper"]');
      await tamper.click();
      await this.emulator.waitForStatus(this.config.testRpmId, (status) => status.tamper_fault, "tamper to assert through emulator GUI");
      await this.check({
        scenario: "rpm-faults", category: "emulator-control", action: "assert tamper with emulator GUI",
        target: this.config.testRpmId, expected: "tamper button becomes active and RPM status reports tamper",
      }, async () => {
        await poll(
          () => tamper.getAttribute("class"),
          (className) => Boolean(className?.includes("active")),
          {timeoutMs: 10_000, intervalMs: 500, description: "tamper button active state"},
        );
        return {passed: true, observed: "emulator GUI control active; API status true"};
      });
      await this.check({
        scenario: "rpm-faults", category: "fault-detection", action: "detect Tamper",
        target: this.config.testLaneLabel, expected: "Tamper: Fault appears in Status of Health",
      }, async () => {
        const text = await this.waitHealthText(page, "Tamper: Fault");
        return {passed: text.includes("Tamper: Fault"), observed: "Tamper: Fault visible"};
      });
      await this.check({
        scenario: "rpm-faults", category: "dashboard-health", action: "show Tamper on dashboard",
        target: this.config.testLaneLabel, expected: "Tamper compact indicator is Active and exposes the lane-specific clear control",
      }, async () => {
        const count = await this.waitDashboardFaultState(page, "tamper", "active");
        const indicatorLabel = await this.dashboardFault(page, "tamper").getAttribute("aria-label") ?? "";
        const clearButton = this.dashboardCard(page).getByRole("button", {name: /clear tamper/i});
        const buttonVisible = await clearButton.isVisible().catch(() => false);
        const passed = count === 1 && indicatorLabel === "Tamper: Fault" && buttonVisible;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-tamper-active");
        return {
          passed,
          observed: `active indicators=${count}; aria-label=${indicatorLabel}; clear control visible=${buttonVisible}`,
          evidence,
        };
      });
      await this.check({
        scenario: "rpm-faults", category: "dashboard-health", action: "clear Tamper without opening lane details",
        target: this.config.testLaneLabel, expected: "clear-tamper opens its confirmation in place, posts the manual clear command, and removes the SensorHub Tamper indicator without navigating",
      }, async () => {
        const originalPath = normalizePathname(new URL(page.url()).pathname);
        const clearButton = this.dashboardCard(page).getByRole("button", {name: /clear tamper/i});
        await clearButton.click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({timeout: this.config.uiTimeoutMs});
        const pathAfterOpen = normalizePathname(new URL(page.url()).pathname);
        const commandResponsePromise = page.waitForResponse((response) => {
          let pathname = "";
          try { pathname = new URL(response.url()).pathname; } catch { return false; }
          return response.request().method() === "POST" &&
            /\/controlstreams\/[^/]+\/commands\/?$/.test(pathname);
        }, {timeout: this.config.uiTimeoutMs});
        await dialog.getByRole("button", {name: /clear tamper/i}).click();
        const commandResponse = await commandResponsePromise;
        if (!commandResponse.ok()) {
          throw new Error(`Manual tamper clear returned HTTP ${commandResponse.status()}`);
        }
        await poll(
          () => this.dashboardFault(page, "tamper").count(),
          (count) => count === 0,
          {timeoutMs: 60_000, intervalMs: 1_000, description: "dashboard Tamper indicator to clear after command"},
        );
        const finalPath = normalizePathname(new URL(page.url()).pathname);
        const stayedOnDashboard = originalPath === "/" && pathAfterOpen === "/" && finalPath === "/";
        const passed = stayedOnDashboard;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-tamper-clear-isolation");
        return {
          passed,
          observed: `command HTTP ${commandResponse.status()}; paths=${originalPath}|${pathAfterOpen}|${finalPath}; SensorHub Tamper active=false`,
          evidence,
        };
      });
    } finally {
      await this.emulator.fault(this.config.testRpmId, "tamper", false).catch(() => undefined);
      await emulatorPage.close();
    }
    await this.check({
      scenario: "rpm-faults", category: "fault-resolution", action: "resolve Tamper",
      target: this.config.testLaneLabel, expected: "Tamper: Clear appears in Status of Health",
    }, async () => {
      const text = await this.waitHealthText(page, "Tamper: Clear");
      return {passed: text.includes("Tamper: Clear"), observed: "Tamper: Clear visible"};
    });
    await this.check({
      scenario: "rpm-faults", category: "dashboard-health", action: "keep cleared Tamper hidden on dashboard",
      target: this.config.testLaneLabel, expected: "Tamper compact indicator remains absent after a fresh health snapshot",
    }, async () => {
      const count = await this.waitDashboardFaultState(page, "tamper", "clear");
      return {passed: count === 0, observed: `remaining indicators=${count}`};
    });
  }

  private async faults(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      await this.faultViaApi(page, "gh", "Gamma high", "gamma-high");
      await this.faultViaApi(page, "gl", "Gamma low", "gamma-low");
      await this.faultViaApi(page, "nh", "Neutron high", "neutron-high");
      await this.tamperViaEmulatorGui(page);
    } finally {
      await this.emulator.clearFaults(this.config.testRpmId).catch((error) => this.reporter.error("rpm-faults", "final-clear", error));
      await page.close();
    }
  }

  private alarmMediaRunKey(): string {
    return safeName(this.reporter.runId).replaceAll(/[.-]+/g, "_").slice(-80);
  }

  private async configuredAlarmCameraUids(): Promise<string[]> {
    if (this.alarmCameraUids) return this.alarmCameraUids;
    const page = await this.browser.oscarPage();
    try {
      await this.goto(page, "/");
      const cameras = this.dashboardCard(page).locator(
        `[data-testid="lane-health-${this.config.testLaneLabel}-camera"]`,
      );
      await cameras.first().waitFor({timeout: this.config.uiTimeoutMs});
      const componentIds = (await cameras.evaluateAll(nodes => nodes.map(node =>
        (node.getAttribute("data-component-id") ?? "").trim())))
        .filter(Boolean);
      const response = await page.context().request.get(this.viewerUrl(
        "/sensorhub/api/systems?searchMembers=true&validTime=latest&limit=500",
      ));
      try {
        if (!response.ok()) throw new Error(`camera systems catalog returned HTTP ${response.status()}`);
        const catalog = await response.json();
        this.alarmCameraUids = cameraUidsForSystemComponents(catalog, componentIds);
        this.alarmLaneUid = laneUidForSystemName(catalog, this.config.testLaneLabel);
        return this.alarmCameraUids;
      } finally {
        await response.dispose();
      }
    } finally {
      await page.close();
    }
  }

  private async configuredAlarmLaneUid(): Promise<string> {
    if (!this.alarmLaneUid) await this.configuredAlarmCameraUids();
    if (!this.alarmLaneUid) throw new Error("the reserved lane has no authoritative OSH lane UID");
    return this.alarmLaneUid;
  }

  private async ensureAlarmMediaBaseline(scenario: string): Promise<void> {
    if (!this.selected("storage-lifecycle") || this.alarmMediaBaselineCreated ||
        this.config.storageWorkflow === "disabled") return;
    if (!this.config.oscarSshTarget || !this.config.oscarReleaseDirectory) {
      if (this.config.storageWorkflow === "required") {
        throw new Error("Required alarm-media forensics need OSCAR_SSH_TARGET and OSCAR_RELEASE_DIR");
      }
      return;
    }
    this.alarmMediaProbe ??= new StorageProbeClient(this.config, this.reporter.runId);
    const created = await this.check({
      scenario,
      category: "alarm-media",
      action: "capture pre-trigger alarm-media baseline",
      target: this.config.testLaneLabel,
      expected: "a private pre-trigger baseline inventories finalized and partial clips before any generated event exists",
    }, async () => {
      const value = await this.alarmMediaProbe!.runJson<{
        baselineCreated: boolean;
        baselineFinalized: number;
        baselinePartials: number;
      }>("alarm-media-baseline", [this.alarmMediaRunKey()]);
      const passed = value.baselineCreated === true &&
        Number.isSafeInteger(value.baselineFinalized) && value.baselineFinalized >= 0 &&
        Number.isSafeInteger(value.baselinePartials) && value.baselinePartials >= 0;
      return {passed, value: passed, observed: JSON.stringify(value)};
    });
    if (!created) throw new Error("Alarm trigger refused because its scoped media baseline failed");
    this.alarmMediaBaselineCreated = true;
  }

  private async resolveAlarmEventUuid(
    page: Page,
    row: Locator,
    type: "gamma" | "neutron",
    occupancyCount: number,
    scenario: string,
  ): Promise<string | undefined> {
    return this.check({
      scenario,
      category: "event-identity",
      action: `resolve exact ${type} alarm UUID`,
      target: `${this.config.testLaneLabel}:${occupancyCount}`,
      expected: "the selected Event Log row opens an Event Details URL with the same nonblank occupancy UUID",
    }, async () => {
      await Promise.all([
        page.waitForURL(
          (url) => normalizePathname(url.pathname) === "/event-details",
          {timeout: this.config.eventTimeoutMs, waitUntil: "domcontentloaded"},
        ),
        row.dblclick(),
      ]);
      const uuidValue = page.getByTestId("event-uuid-value");
      await uuidValue.waitFor({timeout: this.config.eventTimeoutMs});
      const eventId = (await uuidValue.innerText()).trim();
      const url = new URL(page.url());
      const passed = isPublicObservationId(eventId) && url.searchParams.get("eventId") === eventId;
      return {
        passed,
        value: passed ? eventId : undefined,
        observed: `UUID=${eventId || "missing"}; URL identity matches=${url.searchParams.get("eventId") === eventId}`,
        evidence: passed ? "" : await this.screenshotOnFailure(page, `${scenario}-${type}-uuid`),
      };
    });
  }

  private async browserMp4Metadata(
    page: Page,
    paths: readonly string[],
  ): Promise<Array<{path: string; loaded: boolean; duration: number; width: number; height: number}>> {
    const urls = paths.map(path => ({path, url: this.viewerUrl(`/sensorhub/buckets/${path}`)}));
    return page.evaluate(async ({items, timeoutMs}) => {
      const results: Array<{path: string; loaded: boolean; duration: number; width: number; height: number}> = [];
      for (const item of items) {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;
        video.style.display = "none";
        document.body.append(video);
        const metadata = await new Promise<{loaded: boolean; duration: number; width: number; height: number}>(resolve => {
          let settled = false;
          const finish = (loaded: boolean) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve({
              loaded,
              duration: Number.isFinite(video.duration) ? video.duration : 0,
              width: video.videoWidth,
              height: video.videoHeight,
            });
          };
          const timer = window.setTimeout(() => finish(false), timeoutMs);
          video.addEventListener("loadedmetadata", () => finish(video.readyState >= HTMLMediaElement.HAVE_METADATA),
            {once: true});
          video.addEventListener("error", () => finish(false), {once: true});
          video.src = item.url;
          video.load();
        });
        video.removeAttribute("src");
        video.load();
        video.remove();
        results.push({path: item.path, ...metadata});
      }
      return results;
    }, {items: urls, timeoutMs: Math.min(this.config.eventTimeoutMs, 30_000)});
  }

  private async captureAlarmMedia(
    page: Page,
    eventId: string,
    type: "gamma" | "neutron",
    occupancyCount: number,
    scenario: string,
  ): Promise<void> {
    const association = await this.check({
      scenario,
      category: "alarm-media",
      action: `bind ${type} alarm UUID to camera clips`,
      target: eventId,
      expected: "authoritative result.videoPaths contains one unique generation-qualified MP4 for every OSH camera system on the lane",
    }, async () => {
      const cameraUids = await this.configuredAlarmCameraUids();
      const value = await poll(async () => {
        const response = await page.context().request.get(
          this.viewerUrl(`/sensorhub/api/observations/${encodeURIComponent(eventId)}`),
          {headers: {Accept: "application/om+json"}},
        );
        try {
          if (!response.ok()) throw new Error(`observation resource returned HTTP ${response.status()}`);
          return assessAlarmVideoObservation(await response.json(), eventId, cameraUids);
        } finally {
          await response.dispose();
        }
      }, candidate => candidate.paths.length === cameraUids.length, {
        timeoutMs: this.config.eventTimeoutMs,
        intervalMs: 1_000,
        description: `${type} alarm ${eventId} to persist authoritative videoPaths`,
      });
      assertAlarmVideoAssociationUnique(
        value,
        [...this.generatedAlarmMedia.values()].map(item => item.association),
      );
      return {
        passed: true,
        value,
        observed: `${value.paths.length} unique path(s); cameras=${value.paths.map(path => path.cameraUid).join(",")}`,
      };
    });
    if (!association) return;
    this.generatedAlarmMedia.set(eventId, {alarmType: type, occupancyCount, association});

    if (this.alarmMediaProbe) {
      await this.check({
        scenario,
        category: "alarm-media",
        action: `verify ${type} source objects exist`,
        target: eventId,
        expected: "every persisted video path is a non-symlink, nonzero source object in the videos bucket",
      }, async () => {
        const value = await this.alarmMediaProbe!.runJson<{paths: number; existing: number; nonzero: number}>(
          "alarm-media-source-status",
          association.paths.map(({path}) => path),
        );
        const passed = value.paths === association.paths.length && value.existing === value.paths &&
          value.nonzero === value.paths;
        return {passed, observed: JSON.stringify(value)};
      });
    }

    await this.check({
      scenario,
      category: "alarm-media",
      action: `load ${type} alarm MP4 metadata in Chromium`,
      target: eventId,
      expected: "every persisted camera MP4 reaches browser loadedmetadata with a positive duration and dimensions",
    }, async () => {
      const metadata = await this.browserMp4Metadata(page, association.paths.map(({path}) => path));
      const passed = metadata.length === association.paths.length && metadata.every(item =>
        item.loaded && item.duration > 0 && item.width > 0 && item.height > 0);
      return {
        passed,
        observed: metadata.map(item =>
          `${item.path}: loaded=${item.loaded}, duration=${item.duration}, ${item.width}x${item.height}`).join("; "),
        evidence: passed ? "" : await this.screenshotOnFailure(page, `${scenario}-${type}-mp4`),
      };
    });
  }

  private async triggerAlarm(
    type: "gamma" | "neutron",
    scenario = "rpm-alarms",
  ): Promise<number | undefined> {
    await this.ensureAlarmMediaBaseline(scenario);
    const before = await this.emulator.waitForIdle(this.config.testRpmId);
    await this.emulator.trigger(this.config.testRpmId, type === "gamma", type === "neutron");
    const active = await this.emulator.waitForStatus(
      this.config.testRpmId,
      (status) => status.state === "OCCUPIED" && (type === "gamma" ? status.is_gamma_alarm : status.is_neutron_alarm),
      `${type} alarm to latch`,
      30_000,
    );
    this.reporter.outcome(
      scenario, "emulator-control", `trigger ${type} alarm`, this.config.testRpmId,
      `occupancy count advances past ${before.occupancy_count} and ${type} latch becomes true`,
      `occupancy=${active.occupancy_count}; gamma=${active.is_gamma_alarm}; neutron=${active.is_neutron_alarm}`,
      active.occupancy_count > before.occupancy_count ? "correct" : "incorrect", 0,
    );
    await this.emulator.waitForIdle(this.config.testRpmId, this.config.eventTimeoutMs);
    return active.occupancy_count;
  }

  private async findAlarmRow(page: Page, statusText: RegExp, occupancyCount: number): Promise<Locator> {
    await this.goto(page, "/event-log");
    await page.locator(".MuiDataGrid-root").waitFor({timeout: this.config.eventTimeoutMs});
    await this.applyLaneEventFilter(page);
    const row = await poll(async () => {
      const laneRows = page.locator(".MuiDataGrid-row").filter({hasText: this.config.testLaneLabel});
      const count = await laneRows.count();
      for (let index = 0; index < count; index++) {
        const candidate = laneRows.nth(index);
        const occupancy = await candidate.locator('[data-field="occupancyCount"]').innerText().catch(() => "");
        if (occupancy.trim() === String(occupancyCount) && statusText.test(await candidate.innerText())) {
          return candidate;
        }
      }
      return null;
    }, (candidate): candidate is Locator => candidate !== null, {
      timeoutMs: this.config.eventTimeoutMs,
      intervalMs: 1_000,
      description: `${statusText} occupancy ${occupancyCount} for ${this.config.testLaneLabel}`,
    });
    if (!row) throw new Error(
      `No ${statusText} occupancy ${occupancyCount} found for ${this.config.testLaneLabel}`,
    );
    return row;
  }

  private async alarms(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      for (const type of ["gamma", "neutron"] as const) {
        const occupancyCount = await this.triggerAlarm(type);
        if (occupancyCount === undefined) throw new Error(`${type} trigger returned no occupancy count`);
        const ingested = await this.check({
          scenario: "rpm-alarms", category: "event-ingestion", action: `ingest ${type} alarm`,
          target: this.config.testLaneLabel, expected: `Event Log shows a new ${type} event on the reserved lane`,
        }, async () => {
          const row = await this.findAlarmRow(page, new RegExp(type, "i"), occupancyCount);
          const text = await row.innerText();
          const passed = new RegExp(type, "i").test(text);
          return {passed, value: passed, observed: text};
        });
        if (!ingested) continue;
        const row = await this.findAlarmRow(page, new RegExp(type, "i"), occupancyCount);
        const eventId = await this.resolveAlarmEventUuid(page, row, type, occupancyCount, "rpm-alarms");
        if (eventId) await this.captureAlarmMedia(page, eventId, type, occupancyCount, "rpm-alarms");
      }
    } finally { await page.close(); }
  }

  private async exportSelectedAlarm(page: Page, expectedEventUuid?: string): Promise<ExportedAlarmArtifacts> {
    const exportButton = page.getByRole("button", {name: /export alarm qr/i});
    if (expectedEventUuid && !await exportButton.isEnabled()) {
      throw new Error("Alarm QR export is disabled even though the occupancy UUID is resolved");
    }
    await exportButton.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/included|points/i).first().waitFor({timeout: 60_000});
    if (expectedEventUuid) {
      const displayedUuid = (await dialog.getByTestId("alarm-qr-export-uuid").innerText()).trim();
      if (displayedUuid !== expectedEventUuid) {
        throw new Error(`Alarm QR dialog UUID mismatch: expected ${expectedEventUuid}; got ${displayedUuid}`);
      }
    }
    const qrButton = dialog.getByRole("button", {name: /download qr image/i});
    await qrButton.waitFor({timeout: 60_000});
    await poll(
      () => qrButton.isEnabled(),
      (enabled) => enabled,
      {timeoutMs: 60_000, intervalMs: 100, description: "QR image download to become available"},
    );
    const qrDownloadPromise = page.waitForEvent("download");
    await qrButton.click();
    const qrDownload = await qrDownloadPromise;
    const qrSuggested = safeName(qrDownload.suggestedFilename()) || "alarm-qr.png";
    const qrImage = join(
      this.reporter.downloadDir,
      qrSuggested.endsWith(".png") ? qrSuggested : `${qrSuggested}.png`,
    );
    await qrDownload.saveAs(qrImage);

    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", {name: /download alarm file/i}).click();
    const download = await downloadPromise;
    const suggested = safeName(download.suggestedFilename()) || "alarm.json";
    const alarmFile = join(this.reporter.downloadDir, suggested.endsWith(".json") ? suggested : `${suggested}.json`);
    await download.saveAs(alarmFile);
    await dialog.getByRole("button", {name: /close/i}).click();
    return {alarmFile, qrImage};
  }

  private async eventUuidWorkflow(): Promise<void> {
    const metadata: CheckMetadata = {
      scenario: "event-uuid",
      category: "event-identity",
      action: "detect occupancy UUID workflow",
      target: "Event Log",
      expected: "UUID search controls are available",
    };
    if (this.config.eventUuidWorkflow === "disabled") {
      this.skip(metadata, "EVENT_UUID_WORKFLOW=disabled");
      return;
    }

    const page = await this.browser.oscarPage();
    try {
      await this.goto(page, "/event-log");
      await page.locator(".MuiDataGrid-root").waitFor({timeout: this.config.eventTimeoutMs});
      const searchInput = page.getByTestId("event-uuid-search-input");
      const searchSubmit = page.getByTestId("event-uuid-search-submit");
      const capabilityPresent = await searchInput.count() > 0 && await searchSubmit.count() > 0;
      if (!capabilityPresent) {
        if (this.config.eventUuidWorkflow === "auto") {
          this.skip(metadata, "UUID workflow is not present on this build (auto detection)");
        } else {
          this.reporter.outcome(
            metadata.scenario, metadata.category, metadata.action, metadata.target,
            metadata.expected, "UUID search controls are absent", "incorrect", 0,
          );
        }
        return;
      }
      this.reporter.outcome(
        metadata.scenario, metadata.category, metadata.action, metadata.target,
        metadata.expected, "UUID search input and submit controls detected", "correct", 0,
      );

      const occupancyCount = await this.triggerAlarm("gamma", "event-uuid");
      if (occupancyCount === undefined) throw new Error("UUID workflow alarm trigger returned no occupancy count");
      const row = await this.findAlarmRow(page, /Gamma/i, occupancyCount);
      await Promise.all([
        page.waitForURL(
          (url) => normalizePathname(url.pathname) === "/event-details",
          {timeout: this.config.eventTimeoutMs, waitUntil: "domcontentloaded"},
        ),
        row.dblclick(),
      ]);
      await page.getByRole("heading", {name: "Event Details"}).waitFor();

      const eventUuid = await this.check({
        scenario: "event-uuid", category: "event-identity", action: "show occupancy UUID on Event Details",
        target: String(occupancyCount), expected: "the persisted occupancy observation identity is visible and canonicalized in the URL",
      }, async () => {
        const uuidValue = page.getByTestId("event-uuid-value");
        await uuidValue.waitFor({timeout: this.config.eventTimeoutMs});
        const uuid = (await uuidValue.innerText()).trim();
        const current = new URL(page.url());
        const validIdentity = isPublicObservationId(uuid);
        const canonical = current.searchParams.get("eventId") === uuid &&
          Boolean(current.searchParams.get("nodeId"));
        const passed = validIdentity && canonical;
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "event-uuid-detail");
        return {
          passed,
          observed: `uuid=${uuid || "missing"}; canonical eventId=${canonical}; nodeId=${current.searchParams.get("nodeId") ?? "missing"}`,
          value: validIdentity ? uuid : undefined,
          evidence,
        };
      });
      if (!eventUuid) return;
      const eventNodeId = new URL(page.url()).searchParams.get("nodeId");
      if (!eventNodeId) return;
      await this.captureAlarmMedia(page, eventUuid, "gamma", occupancyCount, "event-uuid");

      const origin = new URL(this.config.oscarBaseUrl).origin;
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {origin});
      await this.check({
        scenario: "event-uuid", category: "event-identity", action: "copy occupancy UUID",
        target: eventUuid, expected: "Copy UUID writes the exact observation identity to the clipboard",
      }, async () => {
        await page.getByTestId("copy-event-uuid").click();
        const copied = await poll(
          () => page.evaluate(() => navigator.clipboard.readText()),
          (value) => value === eventUuid,
          {timeoutMs: 5_000, intervalMs: 100, description: "copied occupancy UUID"},
        );
        return {passed: copied === eventUuid, observed: `clipboard matches=${copied === eventUuid}`};
      });

      const directLink = await this.check({
        scenario: "event-uuid", category: "event-identity", action: "copy direct event link",
        target: eventUuid, expected: "Copy Direct Link writes a canonical authenticated Viewer URL",
      }, async () => {
        await page.getByTestId("copy-event-direct-link").click();
        const copied = await poll(
          () => page.evaluate(() => navigator.clipboard.readText()),
          (value) => {
            try {
              const url = new URL(value);
              return url.origin === origin && normalizePathname(url.pathname) === "/event-details" &&
                url.searchParams.get("eventId") === eventUuid && url.searchParams.get("nodeId") === eventNodeId;
            } catch { return false; }
          },
          {timeoutMs: 5_000, intervalMs: 100, description: "copied direct event link"},
        );
        const url = new URL(copied);
        return {
          passed: url.origin === origin && normalizePathname(url.pathname) === "/event-details" &&
            url.searchParams.get("eventId") === eventUuid && url.searchParams.get("nodeId") === eventNodeId,
          observed: `${url.pathname}; eventId matches=${url.searchParams.get("eventId") === eventUuid}; nodeId matches=${url.searchParams.get("nodeId") === eventNodeId}`,
          value: copied,
        };
      });

      if (directLink) {
        await this.check({
          scenario: "event-uuid", category: "event-lookup", action: "open direct event link in a fresh page",
          target: eventUuid, expected: "a fresh authenticated page resolves the same occupancy without Redux navigation state",
        }, async () => {
          const freshPage = await this.browser.oscarPage();
          try {
            const response = await freshPage.goto(directLink, {waitUntil: "domcontentloaded"});
            const value = freshPage.getByTestId("event-uuid-value");
            await value.waitFor({timeout: this.config.eventTimeoutMs});
            const resolved = (await value.innerText()).trim();
            const passed = (response?.status() ?? 0) < 400 && resolved === eventUuid &&
              await freshPage.getByTestId("event-lookup-not-found").count() === 0;
            const evidence = passed ? "" : await this.screenshotOnFailure(freshPage, "event-uuid-direct-link");
            return {passed, observed: `HTTP ${response?.status() ?? 0}; resolved UUID matches=${resolved === eventUuid}`, evidence};
          } finally { await freshPage.close(); }
        });
      }

      await this.check({
        scenario: "event-uuid", category: "event-lookup", action: "find event by occupancy UUID",
        target: eventUuid, expected: "UUID search resolves and opens the canonical Event Details URL",
      }, async () => {
        const searchPage = await this.browser.oscarPage();
        try {
          await this.goto(searchPage, "/event-log");
          await searchPage.getByTestId("event-uuid-search-input").locator("input").fill(eventUuid);
          const navigation = searchPage.waitForURL(
            (url) => normalizePathname(url.pathname) === "/event-details" &&
              url.searchParams.get("eventId") === eventUuid &&
              url.searchParams.get("nodeId") === eventNodeId,
            {timeout: this.config.eventTimeoutMs, waitUntil: "domcontentloaded"},
          );
          await searchPage.getByTestId("event-uuid-search-submit").click();
          await navigation;
          const value = searchPage.getByTestId("event-uuid-value");
          await value.waitFor({timeout: this.config.eventTimeoutMs});
          const resolved = (await value.innerText()).trim();
          const url = new URL(searchPage.url());
          const passed = resolved === eventUuid && url.searchParams.get("nodeId") === eventNodeId;
          const evidence = passed ? "" : await this.screenshotOnFailure(searchPage, "event-uuid-search");
          return {passed, observed: `resolved UUID matches=${resolved === eventUuid}; nodeId matches=${url.searchParams.get("nodeId") === eventNodeId}`, evidence};
        } finally { await searchPage.close(); }
      });

      const laneOracle = this.config.laneConfigOracle;
      if (!scopedUuidOperationalViewChecksEnabled(this.config.operationalViewWorkflow, true) || !laneOracle) {
        this.skip({
          scenario: "event-uuid",
          category: "scope",
          action: "enforce operational-view scope during UUID lookup",
          target: this.config.testLaneLabel,
          expected: "UUID lookup preserves a member view and fails closed from a non-member view",
        }, "operational-view workflow is disabled, so scoped UUID lookup is outside this run");
      } else {
        let scopedLookupAvailable = true;
        if (this.config.operationalViewWorkflow === "auto") {
          const detectionView = [...laneOracle.lanesByView.keys()].sort()[0] ?? "east-gate";
          const capabilityPage = await this.browser.oscarPage();
          try {
            await this.goto(capabilityPage, `/?view=${encodeURIComponent(detectionView)}`);
            scopedLookupAvailable = await capabilityPage.getByText(`View: ${detectionView}`, {exact: true})
              .waitFor({timeout: this.config.uiTimeoutMs})
              .then(() => true, () => false);
          } finally {
            await capabilityPage.close();
          }
        }

        if (!scopedUuidOperationalViewChecksEnabled(
          this.config.operationalViewWorkflow,
          scopedLookupAvailable,
        )) {
          this.skip({
            scenario: "event-uuid",
            category: "scope",
            action: "enforce operational-view scope during UUID lookup",
            target: this.config.testLaneLabel,
            expected: "UUID lookup preserves a member view and fails closed from a non-member view",
          }, "operational-view workflow is not present on this build (auto detection)");
        } else {
          const {assignedView, nonMemberView} = operationalViewScopePair(
            laneOracle,
            this.config.testLaneLabel,
          );

          await this.check({
          scenario: "event-uuid",
          category: "scope",
          action: "find event by UUID inside its assigned operational view",
          target: `${eventUuid}@${assignedView}`,
          expected: "UUID search resolves the event and preserves exactly one assigned view parameter",
        }, async () => {
          const scopedPage = await this.browser.oscarPage();
          try {
            await this.goto(scopedPage, `/event-log?view=${encodeURIComponent(assignedView)}`);
            await scopedPage.getByText(`View: ${assignedView}`, {exact: true})
              .waitFor({timeout: this.config.uiTimeoutMs});
            await scopedPage.getByTestId("event-uuid-search-input").locator("input").fill(eventUuid);
            const navigation = scopedPage.waitForURL(
              (url) => normalizePathname(url.pathname) === "/event-details" &&
                url.searchParams.get("eventId") === eventUuid &&
                url.searchParams.get("nodeId") === eventNodeId &&
                url.searchParams.getAll("view").length === 1 &&
                url.searchParams.get("view") === assignedView,
              {timeout: this.config.eventTimeoutMs, waitUntil: "domcontentloaded"},
            );
            await scopedPage.getByTestId("event-uuid-search-submit").click();
            await navigation;
            const uuid = scopedPage.getByTestId("event-uuid-value");
            await uuid.waitFor({timeout: this.config.eventTimeoutMs});
            const resolved = (await uuid.innerText()).trim();
            const url = new URL(scopedPage.url());
            const passed = resolved === eventUuid &&
              url.searchParams.get("nodeId") === eventNodeId &&
              url.searchParams.getAll("view").length === 1 &&
              url.searchParams.get("view") === assignedView &&
              await scopedPage.getByTestId("event-lookup-not-found").count() === 0;
            const evidence = passed ? "" : await this.screenshotOnFailure(
              scopedPage,
              "event-uuid-member-view",
            );
            return {
              passed,
              observed: `resolved UUID matches=${resolved === eventUuid}; ` +
                `nodeId matches=${url.searchParams.get("nodeId") === eventNodeId}; ` +
                `view=${url.searchParams.getAll("view").join(",") || "missing"}`,
              evidence,
            };
          } finally { await scopedPage.close(); }
        });

          await this.check({
          scenario: "event-uuid",
          category: "scope",
          action: "reject event UUID outside its operational view",
          target: `${eventUuid}@${nonMemberView}`,
          expected: "the same UUID fails closed as not found in a known view that excludes its lane",
        }, async () => {
          const scopedPage = await this.browser.oscarPage();
          try {
            return await this.browser.withExpectedMissingObservation(eventUuid, async () => {
              await this.goto(scopedPage, `/event-log?view=${encodeURIComponent(nonMemberView)}`);
              await scopedPage.getByText(`View: ${nonMemberView}`, {exact: true})
                .waitFor({timeout: this.config.uiTimeoutMs});
              await scopedPage.getByTestId("event-uuid-search-input").locator("input").fill(eventUuid);
              const navigation = scopedPage.waitForURL(
                (url) => normalizePathname(url.pathname) === "/event-details" &&
                  url.searchParams.get("eventId") === eventUuid &&
                  url.searchParams.getAll("view").length === 1 &&
                  url.searchParams.get("view") === nonMemberView,
                {timeout: this.config.eventTimeoutMs, waitUntil: "domcontentloaded"},
              );
              await scopedPage.getByTestId("event-uuid-search-submit").click();
              await navigation;
              await scopedPage.getByTestId("event-lookup-not-found")
                .waitFor({timeout: this.config.eventTimeoutMs});
              const url = new URL(scopedPage.url());
              const staleUuid = await scopedPage.getByTestId("event-uuid-value").count() > 0;
              const passed = !staleUuid &&
                url.searchParams.get("nodeId") === null &&
                url.searchParams.getAll("view").length === 1 &&
                url.searchParams.get("view") === nonMemberView;
              const evidence = await this.browser.screenshot(scopedPage, "event-uuid-non-member-view");
              return {
                passed,
                observed: `not-found visible=true; stale UUID visible=${staleUuid}; ` +
                  `nodeId=${url.searchParams.get("nodeId") ?? "absent"}; ` +
                  `view=${url.searchParams.getAll("view").join(",") || "missing"}`,
                evidence,
              };
            });
          } finally { await scopedPage.close(); }
          });
        }
      }

      await this.check({
        scenario: "event-uuid", category: "reports", action: "include occupancy UUID in printable PDF",
        target: eventUuid, expected: "print-to-PDF output contains the full UUID while copy controls are omitted",
      }, async () => {
        const saved = join(this.reporter.downloadDir, `event-${safeName(eventUuid)}.pdf`);
        await page.emulateMedia({media: "print"});
        try {
          const identityVisible = await page.getByTestId("event-identity").isVisible();
          const copyUuidVisible = await page.getByTestId("copy-event-uuid").isVisible();
          const copyLinkVisible = await page.getByTestId("copy-event-direct-link").isVisible();
          const pdf = await page.pdf({format: "Letter", printBackground: true});
          writeFileSync(saved, pdf);
          const parser = new PDFParse({data: pdf});
          let parsed;
          try { parsed = await parser.getText(); } finally { await parser.destroy(); }
          const includesUuid = parsed.text.includes(eventUuid);
          return {
            passed: parsed.total > 0 && identityVisible && includesUuid && !copyUuidVisible && !copyLinkVisible,
            observed: `pages=${parsed.total}; identity visible=${identityVisible}; UUID present=${includesUuid}; copy controls hidden=${!copyUuidVisible && !copyLinkVisible}`,
            evidence: join("downloads", basename(saved)),
          };
        } finally { await page.emulateMedia({media: "screen"}); }
      });

      const alarmFile = await this.check({
        scenario: "event-uuid", category: "alarm-transfer", action: "include occupancy UUID in truncated QR export",
        target: eventUuid, expected: "QR v1 transport document contains the same UUID in payload.event.observationId",
      }, async () => {
        const artifacts = await this.exportSelectedAlarm(page, eventUuid);
        const bytes = readFileSync(artifacts.alarmFile);
        const parsed = JSON.parse(bytes.toString("utf8")) as {
          transport?: string;
          payload?: {schema?: string; version?: number; event?: {observationId?: string}};
        };
        const passed = parsed.payload?.schema === "org.oscar.alarm-transfer" &&
          parsed.payload.version === 1 && parsed.payload.event?.observationId === eventUuid &&
          parsed.transport?.startsWith("OSCAR-ALARM:1:") === true;
        return {
          passed,
          observed: `${bytes.length} bytes; schema/version/UUID/transport valid=${passed}`,
          value: artifacts.alarmFile,
          evidence: join("downloads", basename(artifacts.alarmFile)),
        };
      });

      if (alarmFile) {
        await this.check({
          scenario: "event-uuid", category: "alarm-transfer", action: "preserve UUID through QR import",
          target: eventUuid, expected: "decoding the truncated transport reproduces and displays the same UUID",
        }, async () => {
          const importPage = await this.browser.oscarPage();
          try {
            await this.goto(importPage, "/alarm-transfer");
            await importPage.locator('input[type="file"][accept*="json"]').setInputFiles(alarmFile);
            await importPage.getByText("The alarm data passed its SHA-256 integrity check.", {exact: true})
              .waitFor({timeout: this.config.eventTimeoutMs});
            const importedUuid = (await importPage.getByTestId("alarm-transfer-import-uuid").innerText()).trim();
            const passed = importedUuid === eventUuid;
            const evidence = passed ? "" : await this.screenshotOnFailure(importPage, "event-uuid-qr-import");
            return {passed, observed: `decoded import UUID matches=${passed}`, evidence};
          } finally { await importPage.close(); }
        });
      }

      await this.check({
        scenario: "event-uuid", category: "event-lookup", action: "handle an unavailable occupancy UUID",
        target: "nonexistent event", expected: "a safe direct lookup displays the explicit not-found state without stale event data",
      }, async () => {
        const missingPage = await this.browser.oscarPage();
        const missingUuid = randomUUID();
        try {
          return await this.browser.withExpectedMissingObservation(missingUuid, async () => {
            await this.goto(missingPage, `/event-details?eventId=${encodeURIComponent(missingUuid)}`);
            const notFound = missingPage.getByTestId("event-lookup-not-found");
            await notFound.waitFor({timeout: this.config.eventTimeoutMs});
            const staleUuid = await missingPage.getByTestId("event-uuid-value").count() > 0;
            const evidence = await this.browser.screenshot(missingPage, "event-uuid-not-found");
            return {passed: !staleUuid, observed: `not-found state visible; stale event UUID visible=${staleUuid}`, evidence};
          });
        } finally { await missingPage.close(); }
      });
    } finally { await page.close(); }
  }

  private async adjudicationAndAlarmTransfer(): Promise<void> {
    const occupancyCount = await this.triggerAlarm("gamma");
    if (occupancyCount === undefined) throw new Error("gamma trigger returned no occupancy count");
    const page = await this.browser.oscarPage();
    try {
      const row = await this.findAlarmRow(page, /Gamma/i, occupancyCount);
      await Promise.all([
        page.waitForURL(/\/event-details/, {waitUntil: "domcontentloaded"}),
        row.dblclick(),
      ]);
      await page.getByRole("heading", {name: "Event Details"}).waitFor();

      const alarmArtifacts = await this.check({
        scenario: "adjudication", category: "alarm-transfer", action: "export selected alarm",
        target: this.config.testLaneLabel,
        expected: "Viewer downloads a valid OSCAR offline alarm JSON file and its rendered QR PNG",
      }, async () => {
        const artifacts = await this.exportSelectedAlarm(page);
        const bytes = readFileSync(artifacts.alarmFile);
        const qrBytes = readFileSync(artifacts.qrImage);
        const parsed = JSON.parse(bytes.toString("utf8")) as {
          transport?: string;
          integrity?: {algorithm?: string; digest?: string};
          payload?: {
            schema?: string;
            version?: number;
            source?: {laneId?: string};
            event?: {occupancyId?: string; observationId?: string};
            series?: {
              gamma?: {exportedCount?: number};
              neutron?: {exportedCount?: number};
            };
          };
        };
        const observationId = parsed.payload?.event?.observationId ?? "";
        const exportedOccupancyId = parsed.payload?.event?.occupancyId ?? "";
        const schemaValid = parsed.payload?.schema === "org.oscar.alarm-transfer" &&
          parsed.payload.version === 1 &&
          parsed.payload.source?.laneId === this.config.testLaneLabel &&
          exportedOccupancyId === String(occupancyCount) &&
          isPublicObservationId(observationId) &&
          parsed.integrity?.algorithm === "SHA-256" &&
          /^[a-f0-9]{64}$/i.test(parsed.integrity.digest ?? "") &&
          parsed.transport?.startsWith("OSCAR-ALARM:1:") === true;
        const pngValid = qrBytes.length > 100 &&
          qrBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const expectedChartSeries: AlarmChartSeries[] = [];
        if ((parsed.payload?.series?.gamma?.exportedCount ?? 0) > 0) expectedChartSeries.push("gamma");
        if ((parsed.payload?.series?.neutron?.exportedCount ?? 0) > 0) expectedChartSeries.push("neutron");
        return {
          passed: bytes.length > 100 && schemaValid && pngValid,
          observed: `JSON=${bytes.length} bytes; PNG=${qrBytes.length} bytes; schema/lane/occupancy/integrity valid=${schemaValid}; PNG valid=${pngValid}`,
          value: {...artifacts, observationId, occupancyId: exportedOccupancyId, expectedChartSeries},
          evidence: join("downloads", basename(artifacts.qrImage)),
        };
      });

      if (alarmArtifacts) {
        await this.captureAlarmMedia(
          page,
          alarmArtifacts.observationId,
          "gamma",
          occupancyCount,
          "adjudication",
        );
        const importPage = await this.browser.oscarPage();
        try {
          const imported = await this.check({
            scenario: "adjudication", category: "alarm-transfer", action: "import and validate selected alarm",
            target: "Alarm Transfer", expected: "exported file imports offline and integrity is verified",
          }, async () => {
            await this.goto(importPage, "/alarm-transfer");
            await importPage.locator('input[type="file"][accept*="json"]').setInputFiles(alarmArtifacts.alarmFile);
            await importPage.getByText("The alarm data passed its SHA-256 integrity check.", {exact: true})
              .waitFor({timeout: 30_000});
            const body = await importPage.locator("body").innerText();
            const importedUuid = (await importPage.getByTestId("alarm-transfer-import-uuid").innerText()).trim();
            const passed = importedUuid === alarmArtifacts.observationId &&
              body.includes(this.config.testLaneLabel) &&
              body.includes("The alarm data passed its SHA-256 integrity check.");
            const evidence = await this.browser.screenshot(importPage, "alarm-transfer-imported");
            return {
              passed,
              observed: `UUID matches=${importedUuid === alarmArtifacts.observationId}; ` +
                `lane present=${body.includes(this.config.testLaneLabel)}`,
              value: true,
              evidence,
            };
          });

          if (imported) {
            await this.check({
              scenario: "adjudication",
              category: "alarm-transfer",
              action: "render imported alarm charts",
              target: "Alarm Transfer",
              expected: "each received non-empty measurement series redraws with its chart-specific dataset color",
            }, async () => {
              const charts = importPage.locator("canvas");
              const readCharts = () => charts.evaluateAll((elements): AlarmChartCanvasSnapshot[] =>
                elements.map((element) => {
                  const canvas = element as HTMLCanvasElement;
                  const context = canvas.getContext("2d");
                  let gammaPlotPixels = 0;
                  let neutronPlotPixels = 0;
                  if (context && canvas.width > 0 && canvas.height > 0) {
                    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    // Chart.js renders its title and legend above the plotting area. Restrict
                    // color evidence to the central/lower chart region so a legend swatch
                    // cannot make an empty dataset appear rendered.
                    const firstPlotRow = Math.floor(canvas.height * 0.30);
                    const lastPlotRow = Math.ceil(canvas.height * 0.90);
                    const firstPlotColumn = Math.floor(canvas.width * 0.05);
                    const lastPlotColumn = Math.ceil(canvas.width * 0.95);
                    for (let y = firstPlotRow; y < lastPlotRow; y++) {
                      for (let x = firstPlotColumn; x < lastPlotColumn; x++) {
                        const index = (y * canvas.width + x) * 4;
                        const red = pixels[index] ?? 0;
                        const green = pixels[index + 1] ?? 0;
                        const blue = pixels[index + 2] ?? 0;
                        const alpha = pixels[index + 3] ?? 0;
                        if (alpha === 0) continue;
                        if (Math.abs(red - 244) <= 24 && Math.abs(green - 67) <= 24 &&
                          Math.abs(blue - 54) <= 24) gammaPlotPixels++;
                        if (Math.abs(red - 41) <= 24 && Math.abs(green - 182) <= 24 &&
                          Math.abs(blue - 246) <= 24) neutronPlotPixels++;
                      }
                    }
                  }
                  const bounds = canvas.getBoundingClientRect();
                  return {
                    width: canvas.width,
                    height: canvas.height,
                    clientWidth: bounds.width,
                    clientHeight: bounds.height,
                    gammaPlotPixels,
                    neutronPlotPixels,
                  };
                }));
              const snapshots = await poll(
                readCharts,
                (value) => importedAlarmChartsRendered(alarmArtifacts.expectedChartSeries, value),
                {
                  timeoutMs: this.config.uiTimeoutMs,
                  intervalMs: 250,
                  description: "imported alarm series datasets to paint",
                },
              );
              const passed = importedAlarmChartsRendered(alarmArtifacts.expectedChartSeries, snapshots);
              const evidence = passed ? "" : await this.screenshotOnFailure(
                importPage,
                "alarm-transfer-imported-charts",
              );
              return {
                passed,
                observed: `expected series=${alarmArtifacts.expectedChartSeries.join(",") || "none"}; ` +
                  `rendered=${snapshots.length}; ` +
                  `gamma plot pixels=${snapshots.map(({gammaPlotPixels}) => gammaPlotPixels).join(",") || "none"}; ` +
                  `neutron plot pixels=${snapshots.map(({neutronPlotPixels}) => neutronPlotPixels).join(",") || "none"}`,
                evidence,
              };
            });

            await this.check({
              scenario: "adjudication",
              category: "alarm-transfer",
              action: "download received alarm package",
              target: "Alarm Transfer",
              expected: "the imported package downloads with the same canonical payload, integrity, transport, and UUID",
            }, async () => {
              const downloadPromise = importPage.waitForEvent("download");
              await importPage.getByRole("button", {name: /download alarm file/i}).click();
              const download = await downloadPromise;
              const suggested = safeName(download.suggestedFilename()) || "alarm.json";
              const receivedFile = join(
                this.reporter.downloadDir,
                `received-${suggested.endsWith(".json") ? suggested : `${suggested}.json`}`,
              );
              await download.saveAs(receivedFile);
              const originalBytes = readFileSync(alarmArtifacts.alarmFile);
              const receivedBytes = readFileSync(receivedFile);
              const original = JSON.parse(originalBytes.toString("utf8")) as unknown;
              const received = JSON.parse(receivedBytes.toString("utf8")) as {
                payload?: {event?: {observationId?: string}};
              };
              const originalCanonicalSha256 = createHash("sha256")
                .update(canonicalAlarmTransferDocumentJson(original)).digest("hex");
              const receivedCanonicalSha256 = createHash("sha256")
                .update(canonicalAlarmTransferDocumentJson(received)).digest("hex");
              const uuidMatches = received.payload?.event?.observationId === alarmArtifacts.observationId;
              const passed = receivedBytes.length > 100 &&
                receivedCanonicalSha256 === originalCanonicalSha256 && uuidMatches;
              return {
                passed,
                observed: `${receivedBytes.length} bytes; canonical document SHA-256 matches=${receivedCanonicalSha256 === originalCanonicalSha256}; ` +
                  `UUID matches=${uuidMatches}`,
                evidence: join("downloads", basename(receivedFile)),
              };
            });
          }
        } finally {
          await importPage.close();
        }

        await this.check({
          scenario: "adjudication", category: "alarm-transfer", action: "decode exported alarm QR image",
          target: "Alarm Transfer",
          expected: "the Viewer decodes its own exported QR PNG and verifies the same alarm identity",
        }, async () => {
          const imagePage = await this.browser.oscarPage();
          try {
            await this.goto(imagePage, "/alarm-transfer");
            await imagePage.locator('input[type="file"][accept*="image"]').setInputFiles(alarmArtifacts.qrImage);
            await imagePage.getByText("The alarm data passed its SHA-256 integrity check.", {exact: true})
              .waitFor({timeout: this.config.eventTimeoutMs});
            const body = await imagePage.locator("body").innerText();
            const importedUuid = (await imagePage.getByTestId("alarm-transfer-import-uuid").innerText()).trim();
            const lanePresent = body.includes(this.config.testLaneLabel);
            const uuidMatches = importedUuid === alarmArtifacts.observationId;
            const passed = lanePresent && uuidMatches;
            const evidence = await this.browser.screenshot(imagePage, "alarm-transfer-qr-image-imported");
            return {
              passed,
              observed: `lane present=${lanePresent}; UUID matches=${uuidMatches}`,
              evidence,
            };
          } finally { await imagePage.close(); }
        });
      }

      await this.check({
        scenario: "adjudication", category: "adjudication", action: "adjudicate alarm",
        target: this.config.testLaneLabel, expected: "full Code 9 adjudication with vehicle ID, inspection, notes, confirmation, and audit log succeeds",
      }, async () => {
        const vehicleId = `REG-${this.reporter.runId.slice(-12)}`;
        const notes = `Regression ${this.reporter.runId.slice(-12)}`;
        await page.getByRole("textbox", {name: "Vehicle ID", exact: true}).fill(vehicleId);
        await this.selectMui(page, "Adjudicate", "Code 9: Authorized Test, Maintenance, or Training Activity");
        await this.selectMui(page, "Secondary Inspection", "NONE");
        await page.getByLabel("Notes").fill(notes);
        await page.getByRole("button", {name: "Submit", exact: true}).click();
        const confirm = page.getByRole("dialog", {name: /Confirm Adjudication Submission/i});
        await confirm.waitFor();
        await confirm.getByRole("button", {name: /Confirm & Submit/i}).click();
        await page.getByText(/Adjudication successful for Occupancy ID/i).waitFor({timeout: 60_000});
        await page.getByText("Logged Adjudications", {exact: true}).waitFor();
        await page.reload({waitUntil: "domcontentloaded"});
        await page.getByText("Logged Adjudications", {exact: true}).waitFor();
        const body = await poll(
          () => page.locator("body").innerText(),
          (value) => value.includes(vehicleId) && value.includes(notes),
          {timeoutMs: 30_000, intervalMs: 500, description: "submitted adjudication values after reload"},
        ).catch(() => page.locator("body").innerText());
        const vehiclePersisted = body.includes(vehicleId);
        const notesPersisted = body.includes(notes);
        const codePersisted = /Code 9/i.test(body);
        const inspectionPersisted = /\bNone\b/i.test(body);
        const persisted = vehiclePersisted && notesPersisted && codePersisted && inspectionPersisted;
        return {
          passed: persisted,
          observed: `confirmed submission succeeded; reloaded vehicle=${vehiclePersisted}; notes=${notesPersisted}; code9=${codePersisted}; inspection=${inspectionPersisted}`,
        };
      });
    } finally { await page.close(); }
  }

  private async verifyGeneratedAlarmRetention(probe: StorageProbeClient): Promise<void> {
    if (!this.alarmMediaBaselineCreated || this.generatedAlarmMedia.size === 0) {
      if (this.retainedMediaProofDeferred) {
        this.reporter.outcome(
          "storage-lifecycle",
          "retained-media",
          "self-seed retained-media proof",
          this.config.testLaneLabel,
          "at least one exact generated alarm UUID reaches accelerated five-frame retention",
          `baseline=${this.alarmMediaBaselineCreated}; generated events=${this.generatedAlarmMedia.size}`,
          "incorrect",
          0,
        );
      }
      return;
    }
    const generated = [...this.generatedAlarmMedia.values()];
    const expectedLaneUid = await this.configuredAlarmLaneUid();
    const page = await this.browser.oscarPage();
    try {
      await this.goto(page, "/");
      const retained = await this.check({
        scenario: "storage-lifecycle",
        category: "retained-media",
        action: "retain the exact generated alarm clips as five frames",
        target: `${generated.length} generated alarm event(s)`,
        expected: "each exact UUID has one source-bound manifest per camera and five quality-85, hash-valid, Chromium-decodable JPEGs per source",
      }, async () => {
        const assessments = await poll(async () => {
          const available = new Map<string, ReturnType<typeof assessRetainedMediaResponse>>();
          for (const item of generated) {
            const eventId = item.association.eventId;
            const response = await page.evaluate(boundedFetch, {
              url: this.viewerUrl(`/sensorhub/buckets/videos/media/${encodeURIComponent(eventId)}`),
              maxBytes: MAX_RETAINED_CATALOG_BYTES,
              decodeImage: false,
            });
            if (response.status === 404) continue;
            {
              const assessment = assessRetainedMediaResponse(
                parseBoundedJson(response, `retained-media API for ${eventId}`),
                eventId,
              );
              const sourceByCamera = new Map(item.association.paths.map(path => [path.cameraUid, path.path]));
              if (assessment.mediaSetCount !== sourceByCamera.size || assessment.frameCount !== sourceByCamera.size * 5 ||
                  assessment.jpegQualities.some(quality => quality !== 85) ||
                  assessment.mediaSets.some(mediaSet => mediaSet.laneUid !== expectedLaneUid) ||
                  assessment.mediaSets.some(mediaSet => sourceByCamera.get(mediaSet.cameraUid) !== mediaSet.sourceObjectKey) ||
                  assessment.mediaSets.some(mediaSet => !sourceByCamera.has(mediaSet.cameraUid))) {
                throw new Error(`retained manifests do not bind exactly to alarm ${eventId} videoPaths`);
              }
              available.set(eventId, assessment);
            }
          }
          return available;
        }, value => value.size === generated.length, {
          timeoutMs: this.config.storageArchiveTimeoutMs,
          intervalMs: 5_000,
          description: "accelerated retention to publish exact generated alarm manifests",
        });

        let validFrames = 0;
        let expectedFrames = 0;
        for (const assessment of assessments.values()) {
          expectedFrames += assessment.frameCount;
          for (const asset of assessment.assets) {
            const imageUrl = this.viewerUrl(`/sensorhub/buckets/videos/${asset.path}`);
            const image = await page.evaluate(boundedFetch, {
              url: imageUrl,
              maxBytes: Math.min(asset.bytes, MAX_RETAINED_FRAME_BYTES),
              decodeImage: true,
            });
            const bytes = Buffer.from(image.bodyBase64, "base64");
            const valid = image.ok && image.contentType === asset.contentType &&
              image.byteCount === asset.bytes && bytes.length === image.byteCount &&
              image.decodedWidth === asset.width && image.decodedHeight === asset.height &&
              assessJpeg(bytes, asset.bytes, asset.sha256, asset.width, asset.height);
            if (valid) validFrames++;
          }
        }
        const passed = validFrames === expectedFrames;
        return {
          passed,
          value: passed ? assessments : undefined,
          observed: `${assessments.size}/${generated.length} exact event manifest(s); ` +
            `${validFrames}/${expectedFrames} hash-valid and browser-decodable retained JPEGs`,
          evidence: passed ? "" : await this.screenshotOnFailure(page, "generated-alarm-retention"),
        };
      });

      if (retained) {
        for (const [eventId, assessment] of retained) {
          this.recordRetainedBackupExpectations(eventId, assessment);
        }
        await this.check({
          scenario: "storage-lifecycle",
          category: "retained-media",
          action: "verify generated alarm retention ledgers did not retry",
          target: `${generated.length} generated alarm event(s)`,
          expected: "each exact event/camera ledger is published once, has no failure, and names the persisted source path",
        }, async () => {
          let checked = 0;
          const failures: string[] = [];
          for (const item of generated) {
            const assessment = retained.get(item.association.eventId);
            if (!assessment) {
              failures.push(`${item.association.eventId}: missing retained assessment`);
              continue;
            }
            const sourceByCamera = new Map(item.association.paths.map(path => [path.cameraUid, path.path]));
            for (const mediaSet of assessment.mediaSets) {
              const value = await probe.runJson<{
                exists?: boolean;
                ledger?: {
                  eventId?: string;
                  laneUid?: string;
                  cameraUid?: string;
                  sourceObjectKey?: string;
                  state?: string;
                  attempts?: number;
                  failure?: string;
                };
              }>("alarm-media-ledger", [
                Buffer.from(item.association.eventId, "utf8").toString("base64url"),
                Buffer.from(expectedLaneUid, "utf8").toString("base64url"),
                Buffer.from(mediaSet.cameraUid, "utf8").toString("base64url"),
              ]);
              const ledger = value.ledger;
              const expectedSource = sourceByCamera.get(mediaSet.cameraUid);
              const valid = value.exists === true && ledger?.eventId === item.association.eventId &&
                mediaSet.laneUid === expectedLaneUid && ledger.laneUid === expectedLaneUid &&
                ledger.cameraUid === mediaSet.cameraUid &&
                ledger.sourceObjectKey?.replaceAll("\\", "/") === expectedSource &&
                (ledger.state === "PUBLISHED" || ledger.state === "SOURCE_DELETED") &&
                ledger.attempts === 1 && ledger.failure === "";
              checked++;
              if (!valid) failures.push(`${item.association.eventId}/${mediaSet.cameraUid}: invalid ledger`);
            }
          }
          return {
            passed: failures.length === 0 && checked === generated.reduce(
              (count, item) => count + item.association.paths.length, 0),
            observed: `${checked} exact ledger(s); failures=${failures.join("; ") || "none"}`,
          };
        });

        const galleryEventId = generated[0]!.association.eventId;
        await this.verifyRetainedMediaGallery(
          page,
          galleryEventId,
          "storage-lifecycle",
          this.retainedMediaProofDeferred
            ? "render self-seeded retained-media gallery"
            : "render generated retained-media gallery",
          "generated-retained-media-five-frame-gallery",
        );
        this.retainedMediaProofDeferred = false;
      }

      await this.check({
        scenario: "storage-lifecycle",
        category: "alarm-media",
        action: "reject new orphan or partial alarm media",
        target: this.config.testLaneLabel,
        expected: "since the scoped run baseline, every new finalized MP4 is UUID-bound, no new partial exists, and no generated path predates the run",
      }, async () => {
        const expectedPaths = generated.flatMap(item => item.association.paths.map(({path}) => path));
        const value = assessAlarmMediaForensics(
          await probe.runJson("alarm-media-forensics", [this.alarmMediaRunKey(), ...expectedPaths]),
          expectedPaths.length,
        );
        return {passed: alarmMediaForensicsPassed(value), observed: JSON.stringify(value)};
      });
      this.alarmMediaBaselineCreated = false;
    } finally {
      await page.close();
    }
  }

  private storageUnavailable(scenario: string): boolean {
    if (this.config.storageWorkflow === "disabled") {
      this.skip({scenario, category: "storage", action: "exercise OSCAR 3.9.2 storage", target: this.config.targetHost,
        expected: "storage workflow is enabled"}, "STORAGE_WORKFLOW=disabled");
      return true;
    }
    if (!this.config.oscarSshTarget || !this.config.oscarReleaseDirectory) {
      const metadata = {scenario, category: "storage", action: "connect guarded storage probe",
        target: this.config.targetHost, expected: "OSCAR_SSH_TARGET and OSCAR_RELEASE_DIR identify the disposable deployment"};
      if (this.config.storageWorkflow === "auto") this.skip(metadata, "storage target configuration is unavailable");
      else this.reporter.outcome(metadata.scenario, metadata.category, metadata.action, metadata.target,
        metadata.expected, "required storage target configuration is missing", "incorrect", 0);
      return true;
    }
    return false;
  }

  private async verifyRetainedMediaGallery(
    page: Page,
    eventId: string,
    scenario: "storage-health" | "storage-lifecycle",
    action: string,
    evidenceName: string,
  ): Promise<void> {
    await this.check({
      scenario,
      category: "viewer",
      action,
      target: eventId,
      expected: "Event Details renders five choices per camera while lazily fetching only selected frames",
    }, async () => {
      const framePattern = /\/media\/[^/]+\/[^/]+\/frame-0[1-5]\.jpg(?:\?|$)/;
      const frameRequests: string[] = [];
      let inFlightFrameRequests = 0;
      let peakInFlightFrameRequests = 0;
      await page.route(framePattern, async route => {
        frameRequests.push(route.request().url());
        inFlightFrameRequests++;
        peakInFlightFrameRequests = Math.max(peakInFlightFrameRequests, inFlightFrameRequests);
        try {
          // Hold the request briefly so the scheduler's real in-flight bound
          // is observable even on a fast local test network.
          await sleep(150);
          await route.continue();
        } finally {
          inFlightFrameRequests--;
        }
      });
      const node = this.config.storageEventNodeId
        ? `&nodeId=${encodeURIComponent(this.config.storageEventNodeId)}` : "";
      await this.goto(page, `/event-details?eventId=${encodeURIComponent(eventId)}${node}`);
      await page.getByTestId("retained-media-gallery").waitFor({timeout: this.config.eventTimeoutMs});
      const cameras = await page.getByTestId("retained-media-camera").count();
      const thumbnails = await page.getByTestId("retained-media-thumbnail").count();
      if (cameras > 0) {
        await poll(
          () => page.getByTestId("retained-media-main-image").evaluateAll((images, expected) =>
            images.length === expected && images.every(image =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 &&
              image.naturalHeight > 0), cameras),
          Boolean,
          {timeoutMs: this.config.eventTimeoutMs, intervalMs: 100,
            description: "initial retained frames to load and decode in the gallery"},
        );
      }
      const initialRequests = frameRequests.length;
      let selectedFrameLoaded = false;
      let selectedFrameRequested = false;
      if (thumbnails >= 5) {
        const firstCamera = page.getByTestId("retained-media-camera").first();
        const mainImage = firstCamera.getByTestId("retained-media-main-image");
        const initialSource = await mainImage.getAttribute("src");
        const initialMetadata = await firstCamera.getByTestId("retained-media-frame-metadata").innerText();
        await firstCamera.getByTestId("retained-media-thumbnail").nth(4).click();
        const selected = await poll(async () => {
          const source = await mainImage.getAttribute("src").catch(() => null);
          const metadata = await firstCamera.getByTestId("retained-media-frame-metadata").innerText();
          const loaded = await mainImage.evaluate(image => image instanceof HTMLImageElement &&
            image.complete && image.naturalWidth > 0 && image.naturalHeight > 0).catch(() => false);
          return {source, metadata, loaded};
        }, value => Boolean(value.loaded && value.source && value.source !== initialSource &&
            value.metadata !== initialMetadata),
        {timeoutMs: this.config.eventTimeoutMs, intervalMs: 100,
          description: "selected retained frame content to load and replace the initial image"});
        selectedFrameLoaded = Boolean(selected.loaded);
        selectedFrameRequested = frameRequests.slice(initialRequests)
          .some(url => /\/frame-05\.jpg(?:\?|$)/.test(url));
      }
      return {
        passed: cameras > 0 && thumbnails === cameras * 5 &&
          initialRequests === cameras && peakInFlightFrameRequests > 0 &&
          peakInFlightFrameRequests <= 3 && frameRequests.length === initialRequests + 1 &&
          selectedFrameRequested && selectedFrameLoaded,
        observed: `${cameras} camera group(s), ${thumbnails} choices, ` +
          `${initialRequests} initial frame request(s), ${frameRequests.length} after selection, ` +
          `peak in-flight=${peakInFlightFrameRequests}, selected requested=${selectedFrameRequested}, ` +
          `selected loaded=${selectedFrameLoaded}`,
        evidence: await this.browser.screenshot(page, evidenceName),
      };
    });
  }

  private recordRetainedBackupExpectations(
    eventId: string,
    assessment: ReturnType<typeof assessRetainedMediaResponse>,
  ): void {
    const eventToken = Buffer.from(eventId, "utf8").toString("base64url");
    for (const mediaSet of assessment.mediaSets) {
      const laneToken = Buffer.from(mediaSet.laneUid, "utf8").toString("base64url");
      const cameraToken = Buffer.from(mediaSet.cameraUid, "utf8").toString("base64url");
      const assets = assessment.assets
        .filter(asset => asset.path.startsWith(`media/${eventId}/${cameraToken}/`))
        .sort((left, right) => left.path.localeCompare(right.path));
      if (assets.length !== 5 || assets.some((asset, index) =>
        basename(asset.path) !== `frame-0${index + 1}.jpg`)) {
        throw new Error(`Cannot bind backup expectations to five exact frames for ${eventId}/${mediaSet.cameraUid}`);
      }
      const record = [eventToken, laneToken, cameraToken,
        ...assets.flatMap(asset => [asset.sha256, String(asset.bytes)])].join(".");
      if (record.length > 2048 || !/^[A-Za-z0-9_.-]+$/.test(record)) {
        throw new Error("Retained-media backup expectation exceeds the guarded probe argument contract");
      }
      this.retainedBackupExpectations.set(`${eventToken}/${laneToken}/${cameraToken}`, record);
    }
  }

  private async proveConfiguredRetainedMediaEvent(
    eventId: string,
    scenario: "storage-health" | "storage-lifecycle",
  ): Promise<boolean> {
    const page = await this.browser.oscarPage();
    try {
      // Establish a same-origin authenticated document before exercising
      // browser-native fetch/createImageBitmap.
      await this.goto(page, "/");
      const assessment = await this.check({scenario, category: "retained-media",
        action: "verify exact-five retained JPEG API", target: eventId,
        expected: "each retained camera has five quality-85, bounded baseline JPEGs whose hashes, dimensions, content types, and Chromium decodes match"}, async () => {
        const response = await page.evaluate(boundedFetch, {
          url: this.viewerUrl(`/sensorhub/buckets/videos/media/${encodeURIComponent(eventId)}`),
          maxBytes: MAX_RETAINED_CATALOG_BYTES,
          decodeImage: false,
        });
        const assessed = assessRetainedMediaResponse(
          parseBoundedJson(response, `retained-media API for ${eventId}`),
          eventId,
        );
        let valid = 0;
        for (const asset of assessed.assets) {
          const imageUrl = this.viewerUrl(`/sensorhub/buckets/videos/${asset.path}`);
          const image = await page.evaluate(boundedFetch, {
            url: imageUrl,
            maxBytes: Math.min(asset.bytes, MAX_RETAINED_FRAME_BYTES),
            decodeImage: true,
          });
          const bytes = Buffer.from(image.bodyBase64, "base64");
          const verified = image.ok && image.contentType === asset.contentType &&
            image.byteCount === asset.bytes && bytes.length === image.byteCount &&
            image.decodedWidth === asset.width && image.decodedHeight === asset.height &&
            assessJpeg(bytes, asset.bytes, asset.sha256, asset.width, asset.height);
          if (verified) valid++;
        }
        const passed = assessed.jpegQualities.every(quality => quality === 85) &&
          valid === assessed.frameCount;
        return {passed, ...(passed ? {value: assessed} : {}),
          observed: `${assessed.mediaSetCount} camera set(s), ${assessed.frameCount} frames, ` +
            `${valid} statically and browser-decodable JPEGs; qualities=${assessed.jpegQualities.join(",")}`};
      });
      if (!assessment) return false;
      this.recordRetainedBackupExpectations(eventId, assessment);
      await this.verifyRetainedMediaGallery(
        page,
        eventId,
        scenario,
        "render retained-media gallery",
        scenario === "storage-health"
          ? "retained-media-five-frame-gallery"
          : "lifecycle-configured-retained-media-five-frame-gallery",
      );
      return true;
    } finally {
      await page.close();
    }
  }

  private async storageHealth(): Promise<void> {
    if (this.storageUnavailable("storage-health")) return;
    const probe = new StorageProbeClient(this.config, this.reporter.runId);
    try {
      const platform = await this.check({
        scenario: "storage-health", category: "storage-platform", action: "verify PostgreSQL and storage controls",
        target: this.config.targetHost,
        expected: "the running images, deployment/root identities, stable lock, exact WAL command, packaged helpers, backup-root isolation, split noexec/data and executable/native temp mounts, forced JVM temp and JavaCPP cache properties, and complete 3.9.2 storage profile match",
      }, async () => {
        const value = assessStoragePlatform(await probe.runJson("platform"));
        const release = this.config.storageExpectedRelease;
        const resources = value.archiveResources;
        const passed = storagePlatformHasExactReleaseIdentity(value, release) && value.dataChecksums === "on" &&
          value.pgStatStatementsInstalled && value.pgStatStatementsPreloaded &&
          value.schemaVersion === OSCAR_STORAGE_SCHEMA_VERSION &&
          value.schemaChecksum === OSCAR_STORAGE_SCHEMA_CHECKSUM && value.batchRewriteConfigured &&
          value.dailyJournalConfigured &&
          resources.memoryLimitMegabytes === REGRESSION_ARCHIVE_RESOURCES.memoryLimitMegabytes &&
          resources.threads === REGRESSION_ARCHIVE_RESOURCES.threads &&
          resources.maximumTemporaryMegabytes ===
            REGRESSION_ARCHIVE_RESOURCES.maximumTemporaryMegabytes &&
          resources.maximumConcurrentSessions ===
            REGRESSION_ARCHIVE_RESOURCES.maximumConcurrentSessions &&
          resources.sessionAcquireTimeoutSeconds ===
            REGRESSION_ARCHIVE_RESOURCES.sessionAcquireTimeoutSeconds &&
          resources.temporaryDirectory === REGRESSION_ARCHIVE_RESOURCES.temporaryDirectory;
        return {passed, value, observed: JSON.stringify(value)};
      });

      await this.check({
        scenario: "storage-health", category: "cold-archive", action: "verify archive catalog and object checksums",
        target: this.config.targetHost,
        expected: "archive catalog has no failed jobs, parity failures, incomplete objects, checksum errors, or archive/WAL partial artifacts",
      }, async () => {
        const value = assessArchiveHealth(await probe.runJson("archive-health"));
        return {passed: value.failedJobs === 0 && value.parityFailures === 0 &&
          value.incompleteActiveObjects === 0 && value.archivePartialArtifacts === 0 &&
          value.walPartialArtifacts === 0 && value.checksumVerificationPassed,
        observed: JSON.stringify(value)};
      });

      await this.check({
        scenario: "storage-health", category: "cold-archive", action: "verify bounded DuckDB scratch hygiene",
        target: REGRESSION_ARCHIVE_RESOURCES.temporaryDirectory,
        expected: "the configured scratch root is absent or a private archive-disjoint empty runtime directory",
      }, async () => {
        const value = await poll(
          async () => assessArchiveScratch(await probe.runJson("archive-scratch-health")),
          scratch => archiveScratchIsSafe(scratch, false),
          {timeoutMs: 60_000, intervalMs: 1_000,
            description: "DuckDB scratch to become empty between bounded operations"},
        );
        return {passed: archiveScratchIsSafe(value, false), observed: JSON.stringify(value)};
      });

      await this.check({
        scenario: "storage-health", category: "retained-media", action: "verify bounded media metadata health",
        target: "retained-media/v1",
        expected: "checkpoint schema 2 and compact hourly/deletion indexes are structurally valid, with no legacy markers, tombstones, partials, or unsafe entries",
      }, async () => {
        const value = assessMediaMetadataHealth(await probe.runJson("media-metadata-health"));
        return {
          passed: mediaMetadataHealthIsSafe(value, Boolean(this.config.storageRetainedEventId)),
          observed: JSON.stringify(value),
        };
      });

      await this.check({
        scenario: "storage-health", category: "daily-file", action: "verify durable journal publications",
        target: "dailyfiles", expected: "each eligible completed day has an exact 12-key v1 CSV/manifest pair, or a not-yet-eligible current day has durable header-valid journal segments; neither state has links, partials, or unsafe entries",
      }, async () => {
        const value = await probe.runJson<DailyJournalStatus>("journal-status");
        const assessment = assessDailyJournalStatus(value);
        return {
          passed: assessment.passed,
          observed: `${assessment.explanation}; ${JSON.stringify(value)}`,
        };
      });

      const snapshot = await probe.runJson<unknown>("snapshot");
      this.reporter.storageMetric(storageMetricFromProbe("storage-health", snapshot));

      const eventId = this.config.storageRetainedEventId;
      if (!eventId) {
        const metadata = {scenario: "storage-health", category: "retained-media", action: "verify exact-five JPEG API and gallery",
          target: "retained media",
          expected: "a configured retained event or an exact full-run generated alarm proves the API and gallery"};
        if (this.fullRunCanSelfSeedRetainedMedia()) {
          this.retainedMediaProofDeferred = true;
          this.skip(metadata,
            "full profile will self-seed an exact alarm UUID and run this proof after accelerated retention");
        } else if (this.config.storageWorkflow === "required") {
          this.reporter.outcome(metadata.scenario, metadata.category, metadata.action, metadata.target,
            metadata.expected,
            "STORAGE_RETAINED_EVENT_ID is missing and this run cannot self-seed retained media",
            "incorrect", 0);
        } else this.skip(metadata, "no retained-media fixture event configured");
      } else await this.proveConfiguredRetainedMediaEvent(eventId, "storage-health");

      const legacyId = this.config.storageLegacyEventId;
      if (legacyId) {
        const page = await this.browser.oscarPage();
        try {
          await this.check({scenario: "storage-health", category: "viewer", action: "use legacy video fallback",
            target: legacyId, expected: "a 404 retained-media response falls back to the legacy video player"}, async () => {
            const api = await page.context().request.get(this.viewerUrl(
              `/sensorhub/buckets/videos/media/${encodeURIComponent(legacyId)}`));
            const apiMissing = api.status() === 404;
            await api.dispose();
            const node = this.config.storageEventNodeId ? `&nodeId=${encodeURIComponent(this.config.storageEventNodeId)}` : "";
            await this.goto(page, `/event-details?eventId=${encodeURIComponent(legacyId)}${node}`);
            const video = page.locator("video").first();
            await video.waitFor({timeout: this.config.eventTimeoutMs});
            return {passed: apiMissing && await video.isVisible() &&
              await page.getByTestId("retained-media-gallery").count() === 0,
            observed: `API 404=${apiMissing}; legacy video visible=${await video.isVisible()}`};
          });
        } finally { await page.close(); }
      }
      if (platform?.deleteHotAfterArchive === true && this.config.profile === "smoke") {
        this.reporter.error("storage-health", "configuration",
          "deleteHotAfterArchive is enabled on a smoke-only target; require a successful lifecycle/restore qualification before production rollout",
          "", "warning");
      }
    } finally { await probe.cleanup(); }
  }

  private async storageLifecycle(): Promise<void> {
    if (this.storageUnavailable("storage-lifecycle")) return;
    const probe = this.alarmMediaProbe ?? new StorageProbeClient(this.config, this.reporter.runId);
    const fixtureRun = safeName(this.reporter.runId).replaceAll("-", "_").slice(-80);
    let fixtureCreateAttempted = false;
    let apiPage: Page | undefined;
    let directJournalLaneUid: string | undefined;
    let directJournalAfterAppend: DirectJournalLaneState | undefined;
    try {
      const platform = assessStoragePlatform(await probe.runJson("platform"));
      const profileAccepted = await this.check({scenario: "storage-lifecycle", category: "configuration", action: "verify accelerated disposable profile",
        target: this.config.targetHost,
        expected: "the exact OSCAR 3.9.2 release, isolated JVM native/data temp contract, one-day archive profile, and explicit zero-day/five-frame alarm-media test profile are running"}, async () => {
        const media = platform.videoRetention;
        const resources = platform.archiveResources;
        const passed = storagePlatformHasExactReleaseIdentity(platform, this.config.storageExpectedRelease) &&
            platform.deleteHotAfterArchive === true && platform.rollbackGraceDays === 1 &&
            platform.archiveIntervalMinutes === 1 &&
            platform.schemaVersion === OSCAR_STORAGE_SCHEMA_VERSION &&
            platform.schemaChecksum === OSCAR_STORAGE_SCHEMA_CHECKSUM &&
            resources.memoryLimitMegabytes === REGRESSION_ARCHIVE_RESOURCES.memoryLimitMegabytes &&
            resources.threads === REGRESSION_ARCHIVE_RESOURCES.threads &&
            resources.maximumTemporaryMegabytes ===
              REGRESSION_ARCHIVE_RESOURCES.maximumTemporaryMegabytes &&
            resources.maximumConcurrentSessions ===
              REGRESSION_ARCHIVE_RESOURCES.maximumConcurrentSessions &&
            resources.sessionAcquireTimeoutSeconds ===
              REGRESSION_ARCHIVE_RESOURCES.sessionAcquireTimeoutSeconds &&
            resources.temporaryDirectory === REGRESSION_ARCHIVE_RESOURCES.temporaryDirectory &&
            media.enabled === REGRESSION_MEDIA_RETENTION.enabled &&
            media.timeToRetentionDays === REGRESSION_MEDIA_RETENTION.timeToRetentionDays &&
            media.queryPeriodMinutes === REGRESSION_MEDIA_RETENTION.queryPeriodMinutes &&
            media.frameCount === REGRESSION_MEDIA_RETENTION.frameCount &&
            media.jpegQuality === REGRESSION_MEDIA_RETENTION.jpegQuality &&
            media.sourceRollbackGraceHours === REGRESSION_MEDIA_RETENTION.sourceRollbackGraceHours &&
            media.metadataReclamationWorkLimit ===
              REGRESSION_MEDIA_RETENTION.metadataReclamationWorkLimit;
        return {
          passed,
          value: passed,
          observed: JSON.stringify(platform),
        };
      });
      if (!profileAccepted) {
        throw new Error(
          "Storage lifecycle mutation refused because the exact accelerated 3.9.2 archive/media test profile failed",
        );
      }

      const scratchAccepted = await this.check({
        scenario: "storage-lifecycle", category: "cold-archive",
        action: "verify clean DuckDB scratch before fixture mutation",
        target: REGRESSION_ARCHIVE_RESOURCES.temporaryDirectory,
        expected: "the configured private archive-disjoint scratch root is empty between archive operations",
      }, async () => {
        const value = await poll(
          async () => assessArchiveScratch(await probe.runJson("archive-scratch-health")),
          scratch => archiveScratchIsSafe(scratch, false),
          {timeoutMs: 60_000, intervalMs: 1_000,
            description: "pre-lifecycle DuckDB scratch to become empty"},
        );
        return {passed: archiveScratchIsSafe(value, false), observed: JSON.stringify(value)};
      });
      if (!scratchAccepted) {
        throw new Error("Storage lifecycle mutation refused because DuckDB scratch did not become clean");
      }

      if (this.generatedAlarmMedia.size === 0 && this.retainedBackupExpectations.size === 0) {
        const configuredEvent = this.config.storageRetainedEventId;
        if (!configuredEvent) {
          this.reporter.outcome(
            "storage-lifecycle", "retained-media", "require retained-media proof before mutation",
            this.config.testLaneLabel,
            "at least one generated alarm or explicitly configured retained event proves exact five-frame retention",
            "no generated alarm and STORAGE_RETAINED_EVENT_ID is unset",
            "incorrect", 0,
          );
          throw new Error(
            "Storage lifecycle mutation refused without generated or explicitly configured retained-media proof",
          );
        }
        const configuredProof = await this.proveConfiguredRetainedMediaEvent(
          configuredEvent,
          "storage-lifecycle",
        );
        if (!configuredProof) {
          throw new Error("Storage lifecycle mutation refused because configured retained-media proof failed");
        }
      }

      const configuredLane = this.config.laneConfigOracle?.lanes.find(
        lane => lane.name === this.config.testLaneLabel,
      );
      if (!configuredLane) {
        throw new Error("Direct daily-file proof requires the reserved lane in OSCAR_LANE_CONFIG_PATH");
      }
      directJournalLaneUid = configuredLane.uniqueId.startsWith("urn:")
        ? configuredLane.uniqueId
        : `urn:osh:system:lane:${configuredLane.uniqueId}`;
      directJournalAfterAppend = await this.check<DirectJournalLaneState>({
        scenario: "storage-lifecycle", category: "daily-file", action: "prove direct journal append",
        target: directJournalLaneUid,
        expected: "an emulator fault transition appends durable bytes directly to the exact lane journal without unsafe or partial entries",
      }, async () => {
        const before = await probe.runJson<DirectJournalLaneState>(
          "journal-lane-state",
          [directJournalLaneUid!],
        );
        try {
          await this.emulator.waitForIdle(this.config.testRpmId);
          await this.emulator.fault(this.config.testRpmId, "tamper", true);
          await this.emulator.waitForStatus(
            this.config.testRpmId,
            status => status.tamper_fault,
            "direct-journal tamper transition to assert",
          );
          await sleep(1_000);
        } finally {
          await this.emulator.fault(this.config.testRpmId, "tamper", false).catch(() => undefined);
          await this.emulator.waitForStatus(
            this.config.testRpmId,
            status => !status.tamper_fault,
            "direct-journal tamper transition to clear",
          ).catch(() => undefined);
        }
        const after = await poll(
          () => probe.runJson<DirectJournalLaneState>("journal-lane-state", [directJournalLaneUid!]),
          state => state.present && directJournalInventoryValid(state) &&
            state.bytes > before.bytes && state.files > 0,
          {timeoutMs: 30_000, intervalMs: 1_000, description: "reserved lane journal bytes to advance"},
        );
        const passed = after.present && directJournalInventoryValid(after) &&
          after.bytes > before.bytes && after.files > 0 &&
          after.openSegments + after.sealedSegments > 0 && after.partialFiles === 0 &&
          after.unsafeEntries === 0;
        return {passed, ...(passed ? {value: after} : {}), observed: JSON.stringify({before, after})};
      });
      if (!directJournalAfterAppend) {
        throw new Error("Storage lifecycle refused to continue after the direct daily-file append proof failed");
      }
      await this.verifyGeneratedAlarmRetention(probe);
      if (this.retainedBackupExpectations.size === 0) {
        throw new Error(
          "Storage lifecycle mutation refused because no exact retained-media set completed certification",
        );
      }
      await this.check({
        scenario: "storage-lifecycle", category: "retained-media",
        action: "verify compact media metadata after retention",
        target: "retained-media/v1",
        expected: "generated five-frame media has schema-2 checkpoint state and compact hourly processed indexes with no legacy or unsafe metadata",
      }, async () => {
        const value = assessMediaMetadataHealth(await probe.runJson("media-metadata-health"));
        const requirePopulated = this.generatedAlarmMedia.size > 0;
        return {passed: mediaMetadataHealthIsSafe(value, requirePopulated), observed: JSON.stringify(value)};
      });
      this.reporter.storageMetric(storageMetricFromProbe("storage-lifecycle-before", await probe.runJson("snapshot")));
      fixtureCreateAttempted = true;
      const fixture = await probe.runJson<{coldId: string; hotId: string; datastreamId: number;
        coldTime: string; hotTime: string; activationBlocked: boolean; sourceMutated: boolean;
        staleActivationRejected: boolean; staleRowUnmarked: boolean}>(
          "fixture-create-race", [fixtureRun, String(this.config.storageHotRetentionDays)]);
      await this.check({scenario: "storage-lifecycle", category: "cold-archive",
        action: "reject concurrent source change during archive activation", target: String(fixture.coldId),
        expected: "a controlled source-row change after export makes activation roll back without marking the stale row"}, async () => ({
        passed: fixture.activationBlocked && fixture.sourceMutated && fixture.staleActivationRejected &&
          fixture.staleRowUnmarked,
        observed: JSON.stringify(fixture),
      }));
      const archived = await poll(
        () => probe.runJson<{generationId: string | null; generationState: string | null;
          parityVerified: boolean; generationRows: number; generationMinId: string | null;
          generationMaxId: string | null; markedRows: number; fixtureColdMarked: boolean;
          fixtureHotUnmarked: boolean; exactRowOwnership: boolean}>(
          "fixture-status", [fixtureRun]),
        value => Boolean(value.generationId && value.generationState === "ACTIVE" &&
          value.parityVerified && value.generationRows === 1 && value.markedRows === 1 &&
          value.fixtureColdMarked && value.fixtureHotUnmarked && value.exactRowOwnership),
        {timeoutMs: this.config.storageArchiveTimeoutMs, intervalMs: 5_000,
          description: "the retried exact source row to enter one parity-verified archive generation"},
      );
      await this.check({scenario: "storage-lifecycle", category: "cold-archive", action: "archive deterministic fixture",
        target: String(fixture.coldId),
        expected: "only the exact exported cold row is marked into an ACTIVE parity-verified generation; the hot control remains unmarked"}, async () => ({
          passed: Boolean(archived.generationId && archived.parityVerified && archived.exactRowOwnership &&
            archived.markedRows === 1 && archived.generationMinId === fixture.coldId &&
            archived.generationMaxId === fixture.coldId), observed: JSON.stringify(archived),
        }));
      await this.check({scenario: "storage-lifecycle", category: "portability", action: "export portable archive",
        target: archived.generationId ?? "fixture generation",
        expected: "export contains hash-valid Parquet, manifests, schema material, query.sql, and README"}, async () => {
        const value = await probe.runJson<Record<string, unknown>>("export-check", [fixtureRun]);
        return {passed: value.checksumVerified === true && Number(value.parquetFiles) > 0 &&
          value.querySql === true && value.readme === true, observed: JSON.stringify(value)};
      });
      await this.check({scenario: "storage-lifecycle", category: "portability",
        action: "exercise deployed archive-object helper", target: archived.generationId ?? "fixture generation",
        expected: "the image helper verifies and copies a cataloged object by hash and rejects checksum mismatch and traversal"}, async () => {
        const value = await probe.runJson<Record<string, unknown>>("archive-helper-check", [fixtureRun]);
        const passed = ["verified", "copied", "copyChecksumValid", "mismatchRejected", "traversalRejected"]
          .every(field => value[field] === true);
        return {passed, observed: JSON.stringify(value)};
      });
      await this.check({scenario: "storage-lifecycle", category: "wal-archive",
        action: "exercise deployed WAL publication helper", target: this.config.targetHost,
        expected: "a synthetic disposable history file publishes durably, retries idempotently, rejects different bytes, leaves no partial, and is removed"}, async () => {
        const value = await probe.runJson<Record<string, unknown>>("wal-helper-check", [fixtureRun]);
        const passed = ["published", "idempotentRetry", "mismatchRejected", "originalPreserved", "fixtureRemoved"]
          .every(field => value[field] === true) && value.partialArtifacts === 0;
        return {passed, observed: JSON.stringify(value)};
      });

      apiPage = await this.browser.oscarPage();
      const request = apiPage.context().request;
      const coldPublicId = encodeOshBigId(this.config.storageDatabaseScope, BigInt(fixture.coldId));
      const hotPublicId = encodeOshBigId(this.config.storageDatabaseScope, BigInt(fixture.hotId));
      const streamPublicId = encodeOshBigId(this.config.storageDatabaseScope, BigInt(fixture.datastreamId));
      await probe.runJson("fixture-accelerate", [fixtureRun]);
      const sealed = await poll(
        () => probe.runJson<{generationState: string | null; coldHotPresent: boolean; hotPresent: boolean}>(
          "fixture-status", [fixtureRun]),
        value => value.generationState === "SEALED" && !value.coldHotPresent && value.hotPresent,
        {timeoutMs: this.config.storageArchiveTimeoutMs, intervalMs: 5_000,
          description: "parity-verified fixture generation to seal and delete only its cold hot-store row"},
      );
      await this.check({scenario: "storage-lifecycle", category: "mixed-tier-query", action: "query cold event by ID",
        target: coldPublicId, expected: "the cold observation remains queryable after its PostgreSQL row is removed"}, async () => {
        const response = await request.get(this.viewerUrl(`/sensorhub/api/observations/${encodeURIComponent(coldPublicId)}`));
        return {passed: sealed.generationState === "SEALED" && response.ok(),
          observed: `generation=${sealed.generationState}; hot row=${sealed.coldHotPresent}; HTTP ${response.status()}`};
      });
      await this.check({scenario: "storage-lifecycle", category: "mixed-tier-query", action: "query mixed hot/cold range",
        target: streamPublicId, expected: "one bounded query returns both the cold and hot fixture IDs"}, async () => {
        const start = new Date(Date.parse(fixture.coldTime) - 60_000).toISOString();
        const end = new Date(Date.parse(fixture.hotTime) + 60_000).toISOString();
        const response = await request.get(this.viewerUrl(`/sensorhub/api/datastreams/${encodeURIComponent(streamPublicId)}/observations?phenomenonTime=${encodeURIComponent(`${start}/${end}`)}&limit=10000`));
        if (!response.ok()) return {passed: false, observed: `HTTP ${response.status()}`};
        const ids = parseCollectionIds(await response.json());
        return {passed: ids.includes(coldPublicId) && ids.includes(hotPublicId),
          observed: `${ids.length} IDs; cold=${ids.includes(coldPublicId)}; hot=${ids.includes(hotPublicId)}`};
      });
      const hotHold = await probe.runJson<{
        holdId: string;
        hotId: string;
        resolution: string;
        listed: boolean;
      }>("fixture-hot-hold-create", [fixtureRun]);
      try {
        await this.check({
          scenario: "storage-lifecycle", category: "retention",
          action: "enforce exact hot-observation legal hold",
          target: hotPublicId,
          expected: "a listed HOT_EXACT hold rejects authenticated observation deletion and leaves the hot row queryable",
        }, async () => {
          const deletion = await request.delete(
            this.viewerUrl(`/sensorhub/api/observations/${encodeURIComponent(hotPublicId)}`),
          );
          const deletionStatus = deletion.status();
          const deletionRejected = !deletion.ok();
          await deletion.dispose();
          const stillPresent = await request.get(
            this.viewerUrl(`/sensorhub/api/observations/${encodeURIComponent(hotPublicId)}`),
          );
          const queryStatus = stillPresent.status();
          const queryable = stillPresent.ok();
          await stillPresent.dispose();
          const passed = hotHold.resolution === "HOT_EXACT" && hotHold.listed &&
            hotHold.hotId === fixture.hotId && deletionRejected && queryable;
          return {
            passed,
            observed: `resolution=${hotHold.resolution}; listed=${hotHold.listed}; ` +
              `DELETE HTTP ${deletionStatus}; follow-up GET HTTP ${queryStatus}`,
          };
        });
      } finally {
        const release = await probe.runJson<{released: boolean}>(
          "fixture-hot-hold-release",
          [fixtureRun, hotHold.holdId],
        );
        if (!release.released) throw new Error("Disposable HOT_EXACT hold was not released");
      }
      await this.check({
        scenario: "storage-lifecycle", category: "retention",
        action: "delete hot observation after hold release",
        target: hotPublicId,
        expected: "the same authenticated delete succeeds only after release and the observation is no longer queryable",
      }, async () => {
        const deletion = await request.delete(
          this.viewerUrl(`/sensorhub/api/observations/${encodeURIComponent(hotPublicId)}`),
        );
        const deletionStatus = deletion.status();
        const deleted = deletion.ok();
        await deletion.dispose();
        const missing = await request.get(
          this.viewerUrl(`/sensorhub/api/observations/${encodeURIComponent(hotPublicId)}`),
        );
        const queryStatus = missing.status();
        await missing.dispose();
        return {
          passed: deleted && queryStatus === 404,
          observed: `DELETE HTTP ${deletionStatus}; follow-up GET HTTP ${queryStatus}`,
        };
      });
      await this.check({scenario: "storage-lifecycle", category: "retention", action: "exercise holds and tokenized purge",
        target: archived.generationId ?? "fixture generation",
        expected: "GENERATION_EXACT and COLD_RANGE_CONSERVATIVE holds are listed and exclude the fixture generation from dry-run plans; wrong token changes nothing; exact fixture purge leaves ledger and tombstone"}, async () => {
        const value = await probe.runJson<Record<string, unknown>>("fixture-controls", [fixtureRun]);
        const passed = ["holdCreated", "holdListed", "holdReleased", "generationHoldCreated",
          "generationHoldListed", "generationHoldEnforced", "observationHoldCreated",
          "observationHoldListed", "coldObservationHoldEnforced", "wrongTokenRejected", "purged",
          "objectsDeleted", "tombstonePresent", "ledgerPresent", "tokenReplayRejected"]
          .every(key => value[key] === true) &&
          value.generationHoldResolution === "GENERATION_EXACT" &&
          value.observationHoldResolution === "COLD_RANGE_CONSERVATIVE";
        return {passed, observed: JSON.stringify(value)};
      });
      await this.check({scenario: "storage-lifecycle", category: "cold-archive",
        action: "verify lifecycle left no partial archive artifacts", target: this.config.targetHost,
        expected: "post-purge archive verification passes with no archive-object or WAL partial artifacts"}, async () => {
        const value = assessArchiveHealth(await probe.runJson("archive-health"));
        return {passed: value.failedJobs === 0 && value.parityFailures === 0 &&
          value.incompleteActiveObjects === 0 && value.archivePartialArtifacts === 0 &&
          value.walPartialArtifacts === 0 && value.checksumVerificationPassed,
        observed: JSON.stringify(value)};
      });
      await this.check({
        scenario: "storage-lifecycle", category: "cold-archive",
        action: "verify DuckDB operation scratch cleanup",
        target: REGRESSION_ARCHIVE_RESOURCES.temporaryDirectory,
        expected: "archive/export/query/count/delete sessions leave the private archive-disjoint scratch root empty",
      }, async () => {
        const value = await poll(
          async () => assessArchiveScratch(await probe.runJson("archive-scratch-health")),
          scratch => archiveScratchIsSafe(scratch, true),
          {timeoutMs: 60_000, intervalMs: 1_000,
            description: "post-lifecycle DuckDB scratch to become empty"},
        );
        return {passed: archiveScratchIsSafe(value, true), observed: JSON.stringify(value)};
      });
      await this.check({scenario: "storage-lifecycle", category: "daily-file", action: "recover journal after OSCAR restart",
        target: this.config.targetHost, expected: "OSCAR becomes healthy with no recovery errors or partial publications"}, async () => {
        const value = await probe.runJson<{
          healthy: boolean;
          segmentsChecked: number;
          segmentsPreserved: number;
          segmentFailures: number;
          partialFiles: number;
          recoveryErrors: number;
        }>("journal-restart", [directJournalLaneUid!]);
        const lane = await probe.runJson<DirectJournalLaneState>(
          "journal-lane-state",
          [directJournalLaneUid!],
        );
        const laneDurable = lane.present && directJournalInventoryValid(lane) &&
          lane.bytes >= directJournalAfterAppend!.bytes &&
          lane.files > 0 && lane.openSegments + lane.sealedSegments > 0 &&
          lane.partialFiles === 0 && lane.unsafeEntries === 0;
        const exactRestartPreservation = Number.isSafeInteger(value.segmentsChecked) &&
          value.segmentsChecked > 0 && value.segmentsPreserved === value.segmentsChecked &&
          value.segmentFailures === 0;
        return {passed: value.healthy && exactRestartPreservation &&
          value.partialFiles === 0 && value.recoveryErrors === 0 && laneDurable,
          observed: JSON.stringify({restart: value, lane, preRestart: directJournalAfterAppend})};
      });
      if (this.config.storageBackupWorkflow !== "disabled") {
        await this.check({scenario: "storage-lifecycle", category: "backup", action: "create and automatically verify backup",
          target: this.config.targetHost,
          expected: "backup has regular authenticated markers, a matching 3.9.2 epoch, supported re-verification, catalog and daily-journal receipts, and bounded retention without restore"}, async () => {
          const mediaBeforeBackup = assessMediaMetadataHealth(
            await probe.runJson("media-metadata-health"),
          );
          const retainedExpectations = [...this.retainedBackupExpectations.values()].sort();
          if (retainedExpectations.length === 0) {
            throw new Error("Backup certification requires at least one exact retained-media set");
          }
          const value = await probe.runJson<Record<string, unknown>>(
            "backup-check",
            retainedExpectations,
          );
          const exactMembers = Number(value.retainedMediaExactMembersVerified);
          const expectedMembers = Number(value.retainedMediaExpectedMembers);
          const expectedProcessed = Number(value.expectedProcessedIndexes);
          const expectedDeletion = Number(value.expectedDeletionIndexes);
          const metadataIncluded = value.retainedMediaPrefixPresent === true &&
            value.mediaMetadataCheckpointIncluded === true &&
            Number(value.retainedMediaExpectedSets) === retainedExpectations.length &&
            Number.isSafeInteger(expectedMembers) && expectedMembers > retainedExpectations.length * 6 &&
            exactMembers === expectedMembers && expectedProcessed > 0 &&
            expectedProcessed === mediaBeforeBackup.processedIndexFiles &&
            Number(value.processedObservationIndexesIncluded) === expectedProcessed &&
            Number(value.deletionIndexesIncluded) === expectedDeletion;
          const deletionMetadataIncluded = Number.isSafeInteger(Number(value.deletionIndexesIncluded)) &&
            Number(value.deletionIndexesIncluded) === mediaBeforeBackup.deletionIndexFiles &&
            expectedDeletion === mediaBeforeBackup.deletionIndexFiles;
          return {passed: value.automaticVerification === true && value.supportedVerification === true &&
            value.independentCoreAuthentication === true &&
            value.authenticatedManifest === true && value.journalConfirmationAuthenticated === true &&
            value.regularMarkers === true && value.epochValid === true &&
            value.verifiedEpoch === true && value.archiveGenerationInventoryExact === true &&
            Number.isSafeInteger(Number(value.archiveGenerationCount)) && Number(value.archiveGenerationCount) >= 0 &&
            Number(value.journalReceipts) > 0 && Number(value.journalReceiptSegmentsVerified) > 0 &&
            value.journalReceiptReferencesValid === true &&
            value.retentionRespected === true && value.duckDbScratchExcluded === true &&
            metadataIncluded && deletionMetadataIncluded && value.restoreAttempted === false,
          observed: JSON.stringify({backup: value, mediaBeforeBackup})};
        });
      }
      await apiPage.close();
      apiPage = undefined;
      this.reporter.storageMetric(storageMetricFromProbe("storage-lifecycle-after", await probe.runJson("snapshot")));
    } finally {
      if (apiPage) await apiPage.close().catch(() => undefined);
      if (fixtureCreateAttempted) await probe.runJson("fixture-cleanup", [fixtureRun]).catch(error =>
        this.reporter.error("storage-lifecycle", "fixture-cleanup", error));
      await probe.cleanup();
      if (this.alarmMediaProbe === probe) this.alarmMediaProbe = undefined;
    }
  }

  private async storageRestoreDrill(): Promise<void> {
    if (this.storageUnavailable("storage-restore-drill")) return;
    const probe = new StorageProbeClient(this.config, this.reporter.runId);
    const fixtureRun = safeName(this.reporter.runId).replaceAll("-", "_").slice(-80);
    try {
      const before = assessStoragePlatform(await probe.runJson("platform"));
      const identityAccepted = await this.check({
        scenario: "storage-restore-drill",
        category: "restore",
        action: "verify exact release identity before destructive restore",
        target: this.config.targetHost,
        expected: "the isolated target is running exact OSCAR/PostGIS 3.9.2 images and the pinned gateway",
      }, async () => {
        const release = this.config.storageExpectedRelease;
        const passed = storagePlatformHasExactReleaseIdentity(before, release);
        return {passed, value: passed, observed: JSON.stringify(before)};
      });
      if (!identityAccepted) throw new Error("Destructive restore refused because exact 3.9.2 identity failed");

      const restoreDisruptionPhase = "storage-restore-drill-disruption";
      this.reporter.expectRemoteMetricDisruptionPhase(restoreDisruptionPhase);
      this.metrics.setPhase(restoreDisruptionPhase);
      let restoreResult: Record<string, unknown> | undefined;
      try {
        restoreResult = await this.check<Record<string, unknown>>({
          scenario: "storage-restore-drill",
          category: "restore",
          action: "restore authenticated backup over isolated deployment",
          target: this.config.targetHost,
          expected: "all pre-backup canaries return, PostgreSQL promotes to a fresh failure-free archive timeline, the exact VERIFIED epoch is reconstructed, and one-time recovery state is cleared",
        }, async () => {
          const value = await probe.runJson<Record<string, unknown>>(
            "restore-drill",
            [
              fixtureRun,
              `${fixtureRun}:DESTRUCTIVE-RESTORE`,
              this.config.restoreArchiveDirectory ?? "missing",
              this.config.restoreWalArchiveDirectory ?? "missing",
              this.config.restoreBackupDirectory ?? "missing",
            ],
          );
          const passed = [
            "databaseRestored", "applicationStateRestored", "archiveRestored", "walRestored",
            "credentialsRestored", "servicesHealthy", "archiveVerified", "freshTimeline",
            "timelineHistoryArchived", "newTimelineWalArchived", "priorWalPreserved",
            "postBackupWalPreserved",
            "archiverFailureFree", "recoverySettingsCleared", "verifiedEpochRestored",
            "allCanariesRestored", "authenticatedBackupReverified", "preRestoreSafetyCopyVerified",
          ].every(field => value[field] === true) &&
            typeof value.backupId === "string" &&
            /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(value.backupId) &&
            typeof value.preRestoreSafetyDirectory === "string";
          return {passed, ...(passed ? {value} : {}), observed: JSON.stringify(value)};
        });
      } finally {
        this.metrics.setPhase("storage-restore-drill-post");
      }

      const after = assessStoragePlatform(await probe.runJson("platform"));
      const immutableImageIdentityPreserved = await this.check<boolean>({
        scenario: "storage-restore-drill",
        category: "restore",
        action: "verify immutable image identity after restore",
        target: this.config.targetHost,
        expected: "restore restarts the exact same immutable application, PostGIS, and gateway image IDs",
      }, async () => {
        const passed = storagePlatformHasExactReleaseIdentity(
          after,
          this.config.storageExpectedRelease,
        ) && after.appImage.containerImageId === before.appImage.containerImageId &&
          after.postgisImage.containerImageId === before.postgisImage.containerImageId &&
          after.gatewayImage.containerImageId === before.gatewayImage.containerImageId;
        return {passed, ...(passed ? {value: true} : {}), observed: JSON.stringify({
          before: {
            app: before.appImage.containerImageId,
            postgis: before.postgisImage.containerImageId,
            gateway: before.gatewayImage.containerImageId,
          },
          after: {
            app: after.appImage.containerImageId,
            postgis: after.postgisImage.containerImageId,
            gateway: after.gatewayImage.containerImageId,
          },
        })};
      });
      if (restoreResult && immutableImageIdentityPreserved === true) {
        this.reporter.addMetadata({
          restoreDrillCertification: {
            schemaVersion: 1,
            backupId: String(restoreResult.backupId),
            authenticatedBackupReverified: true,
            allCanariesRestored: true,
            immutableImageIdentityPreserved: true,
            preRestoreSafetyCopyVerified: true,
          },
        });
      }
      this.reporter.storageMetric(storageMetricFromProbe(
        "storage-restore-drill-after",
        await probe.runJson("snapshot"),
      ));
    } finally {
      await probe.cleanup();
    }
  }

  private async extendedOccupancy(): Promise<void> {
    if (!this.originalRpmConfig) throw new Error("Original RPM configuration is unavailable");
    const quiet = this.emulator.quietConfig(this.originalRpmConfig);
    const page = await this.browser.oscarPage();
    try {
      await this.emulator.replaceConfig(
        this.config.testRpmId,
        this.emulator.extendedOccupancyConfig(this.originalRpmConfig, this.config.extendedOccupancySeconds),
      );
      await this.emulator.waitForStatus(this.config.testRpmId, (status) => status.state === "OCCUPIED", "forced extended occupancy to start", 30_000);
      await this.goto(page, "/health");
      await this.check({
        scenario: "extended-occupancy", category: "fault-detection", action: "detect extended occupancy",
        target: this.config.testLaneLabel, expected: "Extended occupancy: Fault after more than one minute",
      }, async () => {
        const text = await this.waitHealthText(page, "Extended occupancy: Fault", (this.config.extendedOccupancySeconds + 35) * 1_000);
        return {passed: text.includes("Extended occupancy: Fault"), observed: "Extended occupancy: Fault visible"};
      });
      await this.check({
        scenario: "extended-occupancy", category: "dashboard-health", action: "show extended occupancy on dashboard",
        target: this.config.testLaneLabel, expected: "extended-occupancy compact indicator becomes Active after the configured one-minute threshold",
      }, async () => {
        const count = await this.waitDashboardFaultState(
          page,
          "extended-occupancy",
          "active",
          (this.config.extendedOccupancySeconds + 35) * 1_000,
        );
        const label = await this.dashboardFault(page, "extended-occupancy").getAttribute("aria-label") ?? "";
        const passed = count === 1 && label === "Extended occupancy: Fault";
        const evidence = passed ? "" : await this.screenshotOnFailure(page, "dashboard-extended-occupancy-active");
        return {passed, observed: `active indicators=${count}; aria-label=${label}`, evidence};
      });
    } finally {
      await this.emulator.replaceConfig(this.config.testRpmId, quiet).catch((error) => this.reporter.error("extended-occupancy", "restore-quiet-config", error));
    }
    await this.check({
      scenario: "extended-occupancy", category: "fault-resolution", action: "resolve extended occupancy",
      target: this.config.testLaneLabel, expected: "Extended occupancy returns to Clear after occupancy ends",
    }, async () => {
      const text = await this.waitHealthText(page, "Extended occupancy: Clear", 60_000);
      return {passed: text.includes("Extended occupancy: Clear"), observed: "Extended occupancy: Clear visible"};
    });
    await this.check({
      scenario: "extended-occupancy", category: "dashboard-health", action: "clear extended occupancy from dashboard",
      target: this.config.testLaneLabel, expected: "extended-occupancy compact indicator disappears after occupancy ends",
    }, async () => {
      const count = await this.waitDashboardFaultState(page, "extended-occupancy", "clear", 60_000);
      return {passed: count === 0, observed: `remaining indicators=${count}`};
    });
    await page.close();
  }
}
