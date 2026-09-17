// Hand-rolled schema validator (spec §5.4): small, dependency-free, shared by the worker and
// the browser. Unknown object keys are rejected, never stripped.
export type Schema =
  | { type: "object"; properties: Readonly<Record<string, Schema>>; optional?: readonly string[] }
  | { type: "record"; keyPattern: RegExp; value: Schema }
  | { type: "array"; items: Schema; maxLength?: number }
  | { type: "string"; maxLength?: number; pattern?: RegExp }
  | { type: "integer"; min?: number; max?: number }
  | { type: "number"; min?: number; max?: number }
  | { type: "boolean" };

export const LIMITS = Object.freeze({ maxDepth: 32, maxItems: 10_000, maxStringLength: 16_384 });

/** Prototype-pollution guard: these keys are never legal in a record or object payload, own or not. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type ValidationResult = { ok: true } | { ok: false; detail: string };

class Budget {
  items = 0;
  count(path: string): string | null {
    this.items += 1;
    return this.items > LIMITS.maxItems ? `${path}: more than ${LIMITS.maxItems} items` : null;
  }
}

function fail(detail: string): ValidationResult {
  return { ok: false, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // Reject class instances (Date, RegExp, Map, ...) masquerading as plain objects: only a
  // literal-shaped object (or one with a null prototype) is an acceptable payload record.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function check(schema: Schema, value: unknown, path: string, depth: number, budget: Budget): ValidationResult {
  if (depth > LIMITS.maxDepth) return fail(`${path}: deeper than ${LIMITS.maxDepth}`);
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true } : fail(`${path}: expected boolean`);
    case "string": {
      if (typeof value !== "string") return fail(`${path}: expected string`);
      const cap = Math.min(schema.maxLength ?? LIMITS.maxStringLength, LIMITS.maxStringLength);
      if (value.length > cap) return fail(`${path}: longer than ${cap}`);
      if (schema.pattern) {
        // A /g or /y pattern carries lastIndex between calls; reset it so one schema object
        // reused across values (or keys) doesn't intermittently pass/fail based on prior state.
        schema.pattern.lastIndex = 0;
        if (!schema.pattern.test(value)) return fail(`${path}: does not match pattern`);
      }
      return { ok: true };
    }
    case "integer":
    case "number": {
      const isInteger = schema.type === "integer";
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(`${path}: expected ${schema.type}`);
      if (isInteger && !Number.isSafeInteger(value)) return fail(`${path}: expected integer`);
      if (schema.min !== undefined && value < schema.min) return fail(`${path}: below minimum ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) return fail(`${path}: above maximum ${schema.max}`);
      return { ok: true };
    }
    case "array": {
      if (!Array.isArray(value)) return fail(`${path}: expected array`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return fail(`${path}: longer than ${schema.maxLength}`);
      for (let i = 0; i < value.length; i++) {
        const over = budget.count(path);
        if (over) return fail(over);
        const result = check(schema.items, value[i], `${path}[${i}]`, depth + 1, budget);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    case "record": {
      if (!isRecord(value)) return fail(`${path}: expected object`);
      for (const [key, child] of Object.entries(value)) {
        const over = budget.count(path);
        if (over) return fail(over);
        if (FORBIDDEN_KEYS.has(key)) return fail(`${path}.${key}: forbidden key`);
        schema.keyPattern.lastIndex = 0; // see the string-pattern case above
        if (!schema.keyPattern.test(key)) return fail(`${path}.${key}: key does not match pattern`);
        const result = check(schema.value, child, `${path}.${key}`, depth + 1, budget);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    case "object": {
      if (!isRecord(value)) return fail(`${path}: expected object`);
      const optional = new Set(schema.optional ?? []);
      for (const key of Object.keys(value)) {
        const over = budget.count(path);
        if (over) return fail(over);
        if (FORBIDDEN_KEYS.has(key)) return fail(`${path}.${key}: forbidden key`);
        if (!Object.hasOwn(schema.properties, key)) return fail(`${path}.${key}: unknown property`);
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(value, key)) {
          if (optional.has(key)) continue;
          return fail(`${path}.${key}: required`);
        }
        const result = check(child, value[key], `${path}.${key}`, depth + 1, budget);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    default: {
      const exhaustiveCheck: never = schema;
      return fail(`${path}: unknown schema type`);
    }
  }
}

export function validateAgainst(schema: Schema, value: unknown): ValidationResult {
  return check(schema, value, "$", 0, new Budget());
}
