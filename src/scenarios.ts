import {readFileSync, writeFileSync} from "node:fs";
import {createHash, randomUUID} from "node:crypto";
import {basename, join} from "node:path";
import type {Locator, Page} from "playwright";
import {PDFParse} from "pdf-parse";
import {BrowserHarness} from "./browser.js";
import {RpmEmulatorClient} from "./emulator.js";
import {REQUIRED_OPERATIONAL_VIEW_KEYS} from "./lane-config.js";
import {MetricsSampler} from "./metrics.js";
import {RunReporter} from "./reporter.js";
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

function isVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

export class RegressionScenarios {
  private originalRpmConfig: RpmConfig | undefined;
  private originalRpmRunning: boolean | undefined;
  private originalRpmStatus: RpmStatus | null | undefined;
  private reservedLanePrepared = false;
  private stopRequested: () => boolean = () => false;

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

  private async goto(page: Page, path: string): Promise<number> {
    const response = await page.goto(this.viewerUrl(path), {waitUntil: "domcontentloaded"});
    return response?.status() ?? 0;
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
  }

  async runFull(): Promise<void> {
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
    } finally {
      await this.restoreReservedLane();
    }
  }

  async emergencyCleanup(): Promise<void> {
    await this.restoreReservedLane();
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
        const expectedLaneNames = [...fixtureLaneNames].sort();
        await this.check({
          scenario: "operational-views", category: "scope", action: `scope ${key} operational view`,
          target: key,
          expected: `Status of Health navigation retains view=${key} and lists exactly ${expectedLaneNames.join(";")}`,
        }, async () => {
          await this.goto(page, `/?view=${encodeURIComponent(key)}`);
          await page.getByText(`View: ${key}`, {exact: true}).waitFor({timeout: this.config.uiTimeoutMs});

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
            observed: `nav href=${href}; query persisted=${queryPersisted}; exact lanes=${actualLaneNames.length}`,
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
    await page.close();
  }

  private faultFlag(status: RpmStatus, type: "gh" | "gl" | "nh" | "tamper"): boolean {
    if (type === "gh") return status.gh_fault;
    if (type === "gl") return status.gl_fault;
    if (type === "nh") return status.nh_fault;
    return status.tamper_fault;
  }

  private async faultViaApi(page: Page, type: "gh" | "gl" | "nh", label: string): Promise<void> {
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
      await tamper.click();
      await this.emulator.waitForStatus(this.config.testRpmId, (status) => !status.tamper_fault, "tamper to clear through emulator GUI");
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
  }

  private async faults(): Promise<void> {
    const page = await this.browser.oscarPage();
    try {
      await this.faultViaApi(page, "gh", "Gamma high");
      await this.faultViaApi(page, "gl", "Gamma low");
      await this.faultViaApi(page, "nh", "Neutron high");
      await this.tamperViaEmulatorGui(page);
    } finally {
      await this.emulator.clearFaults(this.config.testRpmId).catch((error) => this.reporter.error("rpm-faults", "final-clear", error));
      await page.close();
    }
  }

  private async triggerAlarm(
    type: "gamma" | "neutron",
    scenario = "rpm-alarms",
  ): Promise<number | undefined> {
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
        await this.check({
          scenario: "rpm-alarms", category: "event-ingestion", action: `ingest ${type} alarm`,
          target: this.config.testLaneLabel, expected: `Event Log shows a new ${type} event on the reserved lane`,
        }, async () => {
          const row = await this.findAlarmRow(page, new RegExp(type, "i"), occupancyCount);
          const text = await row.innerText();
          return {passed: new RegExp(type, "i").test(text), observed: text};
        });
      }
    } finally { await page.close(); }
  }

  private async exportSelectedAlarm(page: Page, expectedEventUuid?: string): Promise<string> {
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
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", {name: /download alarm file/i}).click();
    const download = await downloadPromise;
    const suggested = safeName(download.suggestedFilename()) || "alarm.json";
    const path = join(this.reporter.downloadDir, suggested.endsWith(".json") ? suggested : `${suggested}.json`);
    await download.saveAs(path);
    await dialog.getByRole("button", {name: /close/i}).click();
    return path;
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
        const validIdentity = uuid.length > 0 && uuid.length <= 128;
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
        const path = await this.exportSelectedAlarm(page, eventUuid);
        const bytes = readFileSync(path);
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
          value: path,
          evidence: join("downloads", basename(path)),
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

      const alarmFile = await this.check({
        scenario: "adjudication", category: "alarm-transfer", action: "export selected alarm",
        target: this.config.testLaneLabel, expected: "Viewer downloads a non-empty OSCAR offline alarm JSON file",
      }, async () => {
        const path = await this.exportSelectedAlarm(page);
        const bytes = readFileSync(path);
        const parsed = JSON.parse(bytes.toString("utf8")) as {
          transport?: string;
          integrity?: {algorithm?: string; digest?: string};
          payload?: {
            schema?: string;
            version?: number;
            source?: {laneId?: string};
            event?: {occupancyId?: string};
          };
        };
        const schemaValid = parsed.payload?.schema === "org.oscar.alarm-transfer" &&
          parsed.payload.version === 1 &&
          parsed.payload.source?.laneId === this.config.testLaneLabel &&
          parsed.payload.event?.occupancyId === String(occupancyCount) &&
          parsed.integrity?.algorithm === "SHA-256" &&
          /^[a-f0-9]{64}$/i.test(parsed.integrity.digest ?? "") &&
          parsed.transport?.startsWith("OSCAR-ALARM:1:") === true;
        return {
          passed: bytes.length > 100 && schemaValid,
          observed: `${bytes.length} bytes; schema/lane/occupancy/integrity valid=${schemaValid}`,
          value: path,
          evidence: join("downloads", basename(path)),
        };
      });

      if (alarmFile) {
        await this.check({
          scenario: "adjudication", category: "alarm-transfer", action: "import and validate selected alarm",
          target: "Alarm Transfer", expected: "exported file imports offline and integrity is verified",
        }, async () => {
          const importPage = await this.browser.oscarPage();
          try {
            await this.goto(importPage, "/alarm-transfer");
            await importPage.locator('input[type="file"][accept*="json"]').setInputFiles(alarmFile);
            await importPage.getByText("The alarm data passed its SHA-256 integrity check.", {exact: true})
              .waitFor({timeout: 30_000});
            const body = await importPage.locator("body").innerText();
            const passed = body.includes(this.config.testLaneLabel) &&
              body.includes("The alarm data passed its SHA-256 integrity check.");
            const evidence = await this.browser.screenshot(importPage, "alarm-transfer-imported");
            return {passed, observed: `lane present=${body.includes(this.config.testLaneLabel)}`, evidence};
          } finally { await importPage.close(); }
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
    await page.close();
  }
}
