const TOO_MANY_RETRIES_TOKEN = "net::ERR_TOO_MANY_RETRIES";

export interface BoundedNavigationRetryOptions<T> {
  navigate: () => Promise<T>;
  verifyTarget: () => Promise<void>;
  onFirstFailure: (error: unknown) => void | Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
}

export function isTooManyRetriesNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const index = message.indexOf(TOO_MANY_RETRIES_TOKEN);
  if (index < 0) return false;

  const following = message[index + TOO_MANY_RETRIES_TOKEN.length];
  return following === undefined || !/[A-Z0-9_]/i.test(following);
}

export async function navigateWithBoundedRetry<T>(
  options: BoundedNavigationRetryOptions<T>,
): Promise<T> {
  try {
    return await options.navigate();
  } catch (error) {
    if (!isTooManyRetriesNavigationError(error)) throw error;

    await options.onFirstFailure(error);
    await options.verifyTarget();
    await (options.wait ?? defaultWait)(options.retryDelayMs ?? 1_000);

    // Deliberately do not catch the second attempt. A persistent transport
    // failure remains a regression failure rather than becoming an open-ended
    // retry loop.
    return options.navigate();
  }
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
