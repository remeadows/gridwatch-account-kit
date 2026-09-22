import { describe, expect, it } from "vitest";
import { LIMITS, validateAgainst, type Schema } from "../src/saves-schema/validate";

const schema: Schema = {
  type: "object",
  properties: {
    coins: { type: "integer", min: 0 },
    name: { type: "string", maxLength: 8, pattern: /^[a-z]+$/ },
    ratio: { type: "number", min: 0, max: 1 },
    flags: { type: "record", keyPattern: /^[a-z]+$/, value: { type: "boolean" } },
    list: { type: "array", items: { type: "integer" }, maxLength: 3 },
    note: { type: "string" },
  },
  optional: ["note"],
};

describe("validateAgainst", () => {
  it("accepts a conforming object with an optional property missing", () => {
    expect(validateAgainst(schema, { coins: 1, name: "abc", ratio: 0.5, flags: { a: true }, list: [1, 2] })).toEqual({ ok: true });
  });
  it("rejects a missing required property and an unknown property", () => {
    expect(validateAgainst(schema, { name: "abc", ratio: 0.5, flags: {}, list: [] })).toEqual({ ok: false, detail: "$.coins: required" });
    expect(validateAgainst(schema, { coins: 1, name: "abc", ratio: 0.5, flags: {}, list: [], extra: 1 })).toEqual({ ok: false, detail: "$.extra: unknown property" });
  });
  it("rejects wrong types and bounds with the offending path", () => {
    const base = { coins: 1, name: "abc", ratio: 0.5, flags: {}, list: [] };
    expect(validateAgainst(schema, { ...base, coins: 1.5 })).toEqual({ ok: false, detail: "$.coins: expected integer" });
    expect(validateAgainst(schema, { ...base, coins: -1 })).toEqual({ ok: false, detail: "$.coins: below minimum 0" });
    expect(validateAgainst(schema, { ...base, ratio: 2 })).toEqual({ ok: false, detail: "$.ratio: above maximum 1" });
    expect(validateAgainst(schema, { ...base, name: "ABC" })).toEqual({ ok: false, detail: "$.name: does not match pattern" });
    expect(validateAgainst(schema, { ...base, name: "abcdefghij" })).toEqual({ ok: false, detail: "$.name: longer than 8" });
    expect(validateAgainst(schema, { ...base, flags: { "Bad Key": true } })).toEqual({ ok: false, detail: "$.flags.Bad Key: key does not match pattern" });
    expect(validateAgainst(schema, { ...base, flags: { a: 1 } })).toEqual({ ok: false, detail: "$.flags.a: expected boolean" });
    expect(validateAgainst(schema, { ...base, list: [1, 2, 3, 4] })).toEqual({ ok: false, detail: "$.list: longer than 3" });
    expect(validateAgainst(schema, { ...base, list: ["x"] })).toEqual({ ok: false, detail: "$.list[0]: expected integer" });
    expect(validateAgainst(schema, null)).toEqual({ ok: false, detail: "$: expected object" });
    expect(validateAgainst(schema, [])).toEqual({ ok: false, detail: "$: expected object" });
  });
  it("rejects non-finite numbers and unsafe integers", () => {
    const base = { coins: 1, name: "abc", ratio: 0.5, flags: {}, list: [] };
    expect(validateAgainst(schema, { ...base, ratio: Number.NaN })).toEqual({ ok: false, detail: "$.ratio: expected number" });
    expect(validateAgainst(schema, { ...base, coins: 2 ** 53 })).toEqual({ ok: false, detail: "$.coins: expected integer" });
  });
  it("rejects __proto__/constructor/prototype keys before the pattern check (prototype-pollution guard)", () => {
    // Built via JSON.parse so the forbidden key is an own enumerable property, not the actual prototype.
    const recordValue = JSON.parse('{"coins":1,"name":"abc","ratio":0.5,"flags":{"__proto__":true},"list":[]}');
    expect(validateAgainst(schema, recordValue)).toEqual({ ok: false, detail: "$.flags.__proto__: forbidden key" });
    const objectValue = JSON.parse('{"coins":1,"name":"abc","ratio":0.5,"flags":{},"list":[],"constructor":1}');
    expect(validateAgainst(schema, objectValue)).toEqual({ ok: false, detail: "$.constructor: forbidden key" });
  });
  it("rejects a non-plain object like a Date even when the schema is a record type", () => {
    expect(validateAgainst({ type: "record", keyPattern: /./, value: { type: "boolean" } }, new Date())).toEqual({ ok: false, detail: "$: expected object" });
  });
  it("resets a stateful /g pattern's lastIndex before each test instead of carrying state across calls", () => {
    const statefulSchema: Schema = { type: "string", pattern: /^[a-z]+$/g };
    expect(validateAgainst(statefulSchema, "abc")).toEqual({ ok: true });
    expect(validateAgainst(statefulSchema, "abc")).toEqual({ ok: true });
    const keySchema: Schema = { type: "record", keyPattern: /^[a-z]+$/g, value: { type: "boolean" } };
    expect(validateAgainst(keySchema, { abc: true, def: true })).toEqual({ ok: true });
  });
  // Kit v0.2.6 item 5: 1e308 passes Number.isInteger, is a few bytes on the wire, and expands to
  // ~309 characters in Postgres jsonb text — enough of them overrun the database's byte backstop
  // after passing client and worker validation. An `integer` must be a SAFE integer, declared
  // bounds or not.
  it("an integer schema value must be a safe integer, even with no declared max", () => {
    const int: Schema = { type: "integer" };
    const nonNegative: Schema = { type: "integer", min: 0 };
    for (const s of [int, nonNegative]) {
      expect(validateAgainst(s, 2 ** 53)).toEqual({ ok: false, detail: "$: expected integer" });
      expect(validateAgainst(s, 1e308)).toEqual({ ok: false, detail: "$: expected integer" });
      expect(validateAgainst(s, Number.MAX_SAFE_INTEGER)).toEqual({ ok: true });
    }
    expect(validateAgainst(int, -(2 ** 53))).toEqual({ ok: false, detail: "$: expected integer" });
    expect(validateAgainst(int, Number.MIN_SAFE_INTEGER)).toEqual({ ok: true });
  });
  it("enforces the structural caps", () => {
    const deep: Schema = { type: "record", keyPattern: /^d$/, value: { type: "record", keyPattern: /^d$/, value: { type: "boolean" } } };
    let nested: unknown = true;
    for (let i = 0; i < LIMITS.maxDepth + 1; i++) nested = { d: nested };
    expect(validateAgainst({ type: "record", keyPattern: /^d$/, value: deep }, nested).ok).toBe(false);
    const many: Record<string, boolean> = {};
    for (let i = 0; i < LIMITS.maxItems + 1; i++) many[`k${i}`] = true;
    expect(validateAgainst({ type: "record", keyPattern: /^k\d+$/, value: { type: "boolean" } }, many)).toEqual({ ok: false, detail: "$: more than 10000 items" });
    expect(validateAgainst({ type: "string" }, "x".repeat(LIMITS.maxStringLength + 1))).toEqual({ ok: false, detail: "$: longer than 16384" });
  });
});
