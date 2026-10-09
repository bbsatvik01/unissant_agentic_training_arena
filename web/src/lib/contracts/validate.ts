/**
 * Runtime validation of every wire payload (S6 5.2; SG4-05): ajv validators compiled from the wire schemas
 * that WP-02 exports (`generated/schemas.ts`, the same JSON as `contracts/<stem>.schema.json`). Frames, the
 * snapshot and REST payloads are validated before the reducer sees them; a failing payload is dropped and
 * counted, never rendered. `isWire` also applies the invariants JSON Schema cannot state (`invariants.ts`).
 * The stored-card schema is never compiled here: the browser only ever receives the
 * wire cards.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

import { WIRE_SCHEMAS } from "./generated/schemas";
import type { WireTypes } from "./generated/types";
import { invariantErrors } from "./invariants";

export type WireSchemaName = keyof WireTypes;

const utf8 = new TextEncoder();

const ajv = new Ajv2020({ allErrors: true, strict: true });
/** The arena keyword `maxBytes` (S2 1, Text size): a string of at most that many UTF-8 bytes. */
ajv.addKeyword({
  keyword: "maxBytes",
  type: "string",
  schemaType: "number",
  validate: (limit: number, data: string) => utf8.encode(data).length <= limit,
});
const validators = new Map<string, ValidateFunction>(
  Object.entries(WIRE_SCHEMAS).map(([stem, schema]) => [stem, ajv.compile(schema)]),
);

function validatorFor(name: WireSchemaName): ValidateFunction {
  const validate = validators.get(name);
  if (validate === undefined) throw new Error(`no wire schema named ${name}`);
  return validate;
}

/** True when `value` passes the named wire schema and the contract invariants JSON Schema cannot state. */
export function isWire<K extends WireSchemaName>(name: K, value: unknown): value is WireTypes[K] {
  return validatorFor(name)(value) && invariantErrors(name, value).length === 0;
}

/** The ajv errors for `value` against the named wire schema alone; empty when it is valid. */
export function wireErrors(name: WireSchemaName, value: unknown): readonly ErrorObject[] {
  const validate = validatorFor(name);
  return validate(value) ? [] : (validate.errors ?? []);
}

export { invariantErrors };

/** The names of the compiled wire schemas (one per exported wire file). */
export function wireSchemaNames(): readonly string[] {
  return [...validators.keys()];
}
