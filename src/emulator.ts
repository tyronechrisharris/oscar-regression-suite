import type {RpmConfig, RpmResponse, RpmStatus} from "./types.js";
import {poll} from "./util.js";

type FaultType = "gh" | "gl" | "nh" | "tamper";

export class RpmEmulatorClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 15_000) {}

  private async request<T>(path: string, init?: RequestInit, expected = 200): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {...init, signal: controller.signal});
      const body = await response.text();
      if (response.status !== expected) {
        throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 500)}`);
      }
      return (body ? JSON.parse(body) : {}) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  list(): Promise<RpmResponse[]> {
    return this.request<RpmResponse[]>("/api/rpms");
  }

  async get(rpmId: string): Promise<RpmResponse> {
    const rpm = (await this.list()).find((candidate) => candidate.id === rpmId);
    if (!rpm) throw new Error(`RPM ${rpmId} was not found`);
    return rpm;
  }

  status(rpmId: string): Promise<RpmStatus> {
    return this.request<RpmStatus>(`/api/rpms/${encodeURIComponent(rpmId)}/status`);
  }

  async statusOrNull(rpmId: string): Promise<RpmStatus | null> {
    try { return await this.status(rpmId); } catch (error) {
      if (error instanceof Error && error.message.includes(" returned 404:")) return null;
      throw error;
    }
  }

  fault(rpmId: string, type: FaultType, active: boolean): Promise<{message: string}> {
    return this.request(
      `/api/rpms/${encodeURIComponent(rpmId)}/fault?type=${type}&active=${String(active)}`,
      {method: "POST"},
    );
  }

  trigger(rpmId: string, gamma: boolean, neutron: boolean): Promise<{message: string}> {
    if (!gamma && !neutron) throw new Error("At least one alarm source must be selected");
    return this.request(
      `/api/rpms/${encodeURIComponent(rpmId)}/trigger?gamma=${String(gamma)}&neutron=${String(neutron)}`,
      {method: "POST"},
    );
  }

  start(rpmId: string): Promise<{message: string}> {
    return this.request(`/api/rpms/${encodeURIComponent(rpmId)}/start`, {method: "POST"});
  }

  stop(rpmId: string): Promise<{message: string}> {
    return this.request(`/api/rpms/${encodeURIComponent(rpmId)}/stop`, {method: "POST"});
  }

  update(rpmId: string, config: RpmConfig): Promise<{message?: string}> {
    return this.request(`/api/rpms/${encodeURIComponent(rpmId)}`, {
      method: "PUT",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(config),
    });
  }

  waitForStatus(
    rpmId: string,
    accept: (status: RpmStatus) => boolean,
    description: string,
    timeoutMs = 45_000,
  ): Promise<RpmStatus> {
    return poll(() => this.status(rpmId), accept, {timeoutMs, intervalMs: 500, description});
  }

  async waitForStopped(rpmId: string, timeoutMs = 20_000): Promise<RpmResponse> {
    return poll(
      () => this.get(rpmId),
      (rpm) => !rpm.running,
      {timeoutMs, intervalMs: 400, description: `${rpmId} to stop`},
    );
  }

  async waitForConnected(rpmId: string, timeoutMs = 60_000): Promise<RpmStatus> {
    return this.waitForStatus(
      rpmId,
      (status) => status.connected_clients >= 1,
      `${rpmId} to reconnect to OSCAR`,
      timeoutMs,
    );
  }

  async waitForIdle(rpmId: string, timeoutMs = 90_000): Promise<RpmStatus> {
    return this.waitForStatus(rpmId, (status) => status.state === "IDLE", `${rpmId} to become idle`, timeoutMs);
  }

  async clearFaults(rpmId: string): Promise<void> {
    const rpm = await this.get(rpmId);
    if (!rpm.running) await this.start(rpmId);
    for (const type of ["gh", "gl", "nh", "tamper"] as const) {
      await this.fault(rpmId, type, false);
    }
    await this.waitForStatus(
      rpmId,
      (status) => !status.gh_fault && !status.gl_fault && !status.nh_fault && !status.tamper_fault,
      `${rpmId} faults to clear`,
    );
  }

  quietConfig(original: RpmConfig): RpmConfig {
    return {
      ...structuredClone(original),
      occupancy_frequency: 0,
      occupancy_schedule_enabled: false,
      gamma_alarm_probability: 0,
      neutron_alarm_probability: 0,
      unique_alarm_probability: 0,
    };
  }

  extendedOccupancyConfig(original: RpmConfig, durationSeconds: number): RpmConfig {
    return {
      ...this.quietConfig(original),
      occupancy_frequency: 1,
      occupancy_duration_range: [durationSeconds, durationSeconds],
    };
  }

  async replaceConfig(rpmId: string, config: RpmConfig): Promise<RpmStatus> {
    const rpm = await this.get(rpmId);
    if (rpm.running) {
      await this.stop(rpmId);
      await this.waitForStopped(rpmId);
    }
    await this.update(rpmId, config);
    await this.start(rpmId);
    return this.waitForConnected(rpmId);
  }
}
