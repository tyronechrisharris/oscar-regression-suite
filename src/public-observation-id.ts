/**
 * OSCAR exposes an OSH observation's durable public encoded ID to operators as
 * the "Event UUID".  The public ID is opaque and is not required to use RFC
 * 4122 punctuation; Viewer intentionally accepts any trimmed 1-128 character
 * identity and URL-encodes it at request boundaries.
 */
export const MAX_PUBLIC_OBSERVATION_ID_LENGTH = 128;

export function isPublicObservationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_PUBLIC_OBSERVATION_ID_LENGTH && value === value.trim();
}

export function publicObservationId(value: unknown, field: string): string {
  if (!isPublicObservationId(value)) {
    throw new Error(
      `${field} must be a normalized OSCAR public observation ID containing 1-${MAX_PUBLIC_OBSERVATION_ID_LENGTH} characters`,
    );
  }
  return value;
}
