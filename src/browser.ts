import {join} from "node:path";
import {chromium, type Browser, type BrowserContext, type Page} from "playwright";
import type {SuiteConfig} from "./types.js";
import {RunReporter} from "./reporter.js";
import {safeName} from "./util.js";

export class BrowserHarness {
  private browser: Browser | undefined;
  private oscarContext: BrowserContext | undefined;
  private emulatorContext: BrowserContext | undefined;
  private scenario = "browser";

  constructor(private readonly config: SuiteConfig, private readonly reporter: RunReporter) {}

  setScenario(scenario: string): void {
    this.scenario = scenario;
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
      ...(this.config.browserExecutablePath
        ? {executablePath: this.config.browserExecutablePath}
        : {}),
    });
    this.oscarContext = await this.browser.newContext({
      ignoreHTTPSErrors: true,
      httpCredentials: {
        username: this.config.oscarUsername,
        password: this.config.oscarPassword,
      },
      acceptDownloads: true,
      viewport: {width: 1600, height: 1000},
      locale: "en-US",
    });
    this.emulatorContext = await this.browser.newContext({
      viewport: {width: 1600, height: 1000},
      locale: "en-US",
    });
    this.oscarContext.setDefaultTimeout(this.config.uiTimeoutMs);
    this.oscarContext.setDefaultNavigationTimeout(this.config.uiTimeoutMs);
    this.emulatorContext.setDefaultTimeout(this.config.uiTimeoutMs);
    this.attachContext(this.oscarContext, "viewer");
    this.attachContext(this.emulatorContext, "emulator");
    await this.authenticateOscar();
  }

  private async authenticateOscar(): Promise<void> {
    if (!this.oscarContext) throw new Error("OSCAR browser context is unavailable");
    const page = await this.oscarContext.newPage();
    try {
      await page.goto(this.config.oscarBaseUrl, {waitUntil: "domcontentloaded"});
      const username = page.getByLabel("Username");
      if (await username.isVisible().catch(() => false)) {
        await username.fill(this.config.oscarUsername);
        await page.getByLabel("Password").fill(this.config.oscarPassword);
        await Promise.all([
          page.waitForURL((url) => !url.pathname.startsWith("/login"), {timeout: this.config.uiTimeoutMs}),
          page.getByRole("button", {name: "Sign in"}).click(),
        ]);
      }
      const response = await this.oscarContext.request.get(`${this.config.oscarBaseUrl}/session`);
      if (!response.ok()) throw new Error(`OSCAR session verification returned ${response.status()}`);
      const session = await response.json() as {username?: string};
      if (session.username !== this.config.oscarUsername) {
        throw new Error(`OSCAR session belongs to ${session.username ?? "an unknown user"}`);
      }
    } finally {
      await page.close();
    }
  }

  async sessionUsername(): Promise<string> {
    if (!this.oscarContext) throw new Error("Browser harness is not started");
    const response = await this.oscarContext.request.get(`${this.config.oscarBaseUrl}/session`);
    if (!response.ok()) throw new Error(`OSCAR session endpoint returned ${response.status()}`);
    const session = await response.json() as {username?: string};
    return session.username ?? "";
  }

  private attachContext(context: BrowserContext, source: string): void {
    context.on("page", (page) => this.attachPage(page, source));
  }

  private attachPage(page: Page, source: string): void {
    page.on("pageerror", (error) => this.reporter.error(this.scenario, `${source}-page`, error));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      const expectedHeadlessNoise = [
        "An SSL certificate error occurred when fetching the script",
        "Service Worker registration failed: SecurityError",
        "Failed to load resource: the server responded with a status of 404",
        "MUI X: useResizeContainer",
      ].some((fragment) => text.includes(fragment));
      if (!expectedHeadlessNoise) this.reporter.error(this.scenario, `${source}-console`, text, "", "warning");
    });
    page.on("response", (response) => {
      if (response.status() === 404) {
        const url = response.url();
        const expectedPreparingRequest = /(?:\.m3u8|\/hls\/|\/sw\.js(?:\?|$)|\/favicon\.ico(?:\?|$))/i.test(url);
        if (!expectedPreparingRequest) {
          this.reporter.error(
            this.scenario,
            `${source}-http`,
            `404 ${response.request().method()} ${url}`,
          );
        }
      }
      if (response.status() >= 500) {
        this.reporter.error(
          this.scenario,
          `${source}-http`,
          `${response.status()} ${response.request().method()} ${response.url()}`,
          "",
          "warning",
        );
      }
    });
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "request failed";
      if (reason.includes("ERR_ABORTED")) return;
      this.reporter.error(
        this.scenario,
        `${source}-network`,
        `${request.method()} ${request.url()}: ${reason}`,
        "",
        "warning",
      );
    });
  }

  async oscarPage(): Promise<Page> {
    if (!this.oscarContext) throw new Error("Browser harness is not started");
    const page = await this.oscarContext.newPage();
    return page;
  }

  async emulatorPage(): Promise<Page> {
    if (!this.emulatorContext) throw new Error("Browser harness is not started");
    const page = await this.emulatorContext.newPage();
    return page;
  }

  async screenshot(page: Page, label: string): Promise<string> {
    const relative = join("evidence", `${safeName(label)}.png`);
    await page.screenshot({path: join(this.reporter.outputDir, relative), fullPage: true});
    return relative;
  }

  async stop(): Promise<void> {
    await this.oscarContext?.close().catch(() => undefined);
    await this.emulatorContext?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}
