export const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function poll<T>(
  probe: () => Promise<T>,
  accept: (value: T) => boolean,
  options: {timeoutMs: number; intervalMs?: number; description: string},
): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() - started < options.timeoutMs) {
    try {
      last = await probe();
      if (accept(last)) return last;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(options.intervalMs ?? 1_000);
  }
  const detail = lastError instanceof Error ? lastError.message : JSON.stringify(last);
  throw new Error(`Timed out waiting for ${options.description}${detail ? `; last result: ${detail}` : ""}`);
}

export function safeName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 96);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
