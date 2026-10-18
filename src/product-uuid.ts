/**
 * OSCAR product identities are canonical, lowercase RFC 4122 UUIDs.  Restrict
 * versions and the variant nibble as well as shape so UUID claims cannot pass
 * for arbitrary 36-character strings.
 */
export const CANONICAL_PRODUCT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalProductUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_PRODUCT_UUID.test(value);
}

export function canonicalProductUuid(value: unknown, field: string): string {
  if (!isCanonicalProductUuid(value)) {
    throw new Error(`${field} must be a canonical lowercase RFC 4122 UUID`);
  }
  return value;
}
