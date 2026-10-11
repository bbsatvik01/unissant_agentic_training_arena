/**
 * Runtime validation of every wire payload (S6 5.2; SG4-05): ajv validators compiled from the wire schemas
 * that WP-02 exports (`generated/schemas.ts`, the same JSON as `contracts/<stem>.schema.json`). Frames, the
 * snapshot and REST payloads are validated before the reducer sees them; a failing payload is dropped and
 * counted, never rendered. `isWire` also applies the invariants JSON Schema cannot state (`invariants.ts`).
 * The stored-card schema is never compiled here: the browser only ever receives the
 * wire cards.
 *
 * The validators are compiled at build time (`compiled/validators.js`, `web/tools/validators-codegen.ts`): the
 * page's CSP (`script-src 'self'`, S6 1.3) forbids the code generation a run-time ajv compile needs, so nothing
 * here generates code.
 */

import type { ErrorObject, ValidateFunction } from "ajv/dist/2020";

import { WIRE_VALIDATORS } from "./compiled/validators.js";
import type { WireTypes } from "./generated/types";
import { invariantErrors } from "./invariants";

export type WireSchemaName = keyof WireTypes;

function validatorFor(name: WireSchemaName): ValidateFunction {
  const validate = Object.hasOwn(WIRE_VALIDATORS, name) ? WIRE_VALIDATORS[name] : undefined;
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
  return Object.keys(WIRE_VALIDATORS);
}
