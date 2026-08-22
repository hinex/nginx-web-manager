/**
 * Field normalisation shared by the two host save paths.
 *
 * A publish is an UPDATE, and in an UPDATE `undefined` means "leave the column
 * alone" — drizzle omits the key entirely (pinned in
 * `app/lib/db/update-semantics.test.ts`). The `|| undefined` idiom these call
 * sites used therefore could not clear a field: the user emptied the textarea,
 * the save reported success, and the old value stayed in the column and in the
 * next generated config. A cleared optional field is `null`.
 *
 * Emptiness is judged on the trimmed value, but a non-empty field is stored
 * exactly as the user typed it — these are raw nginx fragments where interior
 * and leading whitespace is the user's own formatting.
 */

const NULLABLE_KEYS = [
  "sslCertPath",
  "sslKeyPath",
  "webhookUrl",
  "advancedNginx",
  "customPrelude",
] as const;

type NullableKey = (typeof NULLABLE_KEYS)[number];

export type NullableHostFields = Record<NullableKey, string | null>;

export function nullableHostFields(
  data: Partial<Record<NullableKey, string | null | undefined>>,
): NullableHostFields {
  const out = {} as NullableHostFields;
  for (const key of NULLABLE_KEYS) {
    const value = data[key];
    out[key] = value && value.trim() !== "" ? value : null;
  }
  return out;
}

/**
 * `client_max_body_size` is `.notNull().default("1m")` (schema.ts), so a
 * cleared field falls back to that default instead of null. Unlike the fields
 * above it is a single token, so the trimmed form is the value.
 */
export function clientMaxBodySizeOf(value: string | null | undefined): string {
  return value?.trim() || "1m";
}
