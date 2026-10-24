export interface AlarmTriggerIdentity {
  occupancyCount: number;
  initiatedAtEpochMs: number;
}

export interface AlarmRowIdentity {
  occupancyCount: string;
  startTime: string;
  text: string;
}

/**
 * Event occupancy counters are local to an RPM emulator process/configuration
 * and can be reused after that configuration is replaced.  Bind a Viewer row
 * to the command that created it by requiring both the counter and a start time
 * no earlier than the trigger.  The Viewer deliberately renders whole seconds,
 * so compare against the trigger rounded down to that same precision.
 */
export function alarmRowMatchesTrigger(
  row: AlarmRowIdentity,
  statusText: RegExp,
  trigger: AlarmTriggerIdentity,
): boolean {
  if (!Number.isSafeInteger(trigger.occupancyCount) || trigger.occupancyCount < 0 ||
      !Number.isFinite(trigger.initiatedAtEpochMs)) return false;
  if (row.occupancyCount.trim() !== String(trigger.occupancyCount) || !statusText.test(row.text)) {
    return false;
  }
  const rowStart = Date.parse(row.startTime.trim());
  if (!Number.isFinite(rowStart)) return false;
  const triggerSecond = Math.floor(trigger.initiatedAtEpochMs / 1_000) * 1_000;
  return rowStart >= triggerSecond;
}
