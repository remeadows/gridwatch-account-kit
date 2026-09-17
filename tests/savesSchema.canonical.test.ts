import { describe, expect, it } from "vitest";
import { canonicalJson, requestHash, sha256Hex } from "../src/saves-schema/canonical";

describe("canonicalJson", () => {
  it("sorts object keys recursively and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it("keeps array order and JSON string escaping", () => {
    expect(canonicalJson(["b", "a", "é\n\"q\""])).toBe('["b","a","é\\n\\"q\\""]');
  });
  it("sorts keys by UTF-16 code units like RFC 8785", () => {
    expect(canonicalJson({ "é": 1, z: 2, A: 3, a: 4 })).toBe('{"A":3,"a":4,"z":2,"é":1}');
  });
  it("serializes numbers, booleans and null like JSON.stringify", () => {
    expect(canonicalJson({ n: 1e21, m: -0, t: true, x: null, f: 0.1 })).toBe('{"f":0.1,"m":0,"n":1e+21,"t":true,"x":null}');
  });
  it("rejects values JSON cannot round-trip", () => {
    for (const bad of [undefined, () => 1, Symbol("s"), 10n, Number.NaN, Number.POSITIVE_INFINITY, { a: undefined }, [undefined]]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
    }
  });
  it("rejects non-plain-object values like Date instances", () => {
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
    expect(() => canonicalJson({ when: new Date() })).toThrow(TypeError);
  });
  it("bounds recursion depth instead of blowing the stack", async () => {
    let nested: unknown = 1;
    for (let i = 0; i < 40; i++) nested = { a: nested };
    expect(() => canonicalJson(nested)).toThrow(RangeError);
    expect(() => canonicalJson(nested)).toThrow(/deeper than 32/);
    await expect(requestHash({ game: "g", slot: "s", schemaVersion: 1, baseRevision: 0, payload: nested })).rejects.toThrow(/deeper than 32/);
  });
  it("rejects sparse arrays instead of silently skipping holes (Array.prototype.map skips them)", () => {
    expect(() => canonicalJson(Array(1))).toThrow(TypeError);
    expect(() => canonicalJson([1, , 2])).toThrow(TypeError);
  });
  it("rejects lone UTF-16 surrogates in values and object keys (RFC 8785), but accepts a valid pair", () => {
    expect(() => canonicalJson("\uD800")).toThrow(TypeError);
    expect(() => canonicalJson({ "\uDC00": 1 })).toThrow(TypeError);
    expect(() => canonicalJson("😀")).not.toThrow();
  });
});

describe("sha256Hex / requestHash", () => {
  it("hashes text with SHA-256 as lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("is stable under property reordering and sensitive to baseRevision and payload", async () => {
    const base = { game: "gridwatch-match", slot: "campaign", schemaVersion: 1, baseRevision: 3, payload: { coins: 1, levels: { "1": { stars: 3 } } } };
    const reordered = { payload: { levels: { "1": { stars: 3 } }, coins: 1 }, baseRevision: 3, schemaVersion: 1, slot: "campaign", game: "gridwatch-match" };
    expect(await requestHash(reordered)).toBe(await requestHash(base));
    expect(await requestHash({ ...base, baseRevision: 4 })).not.toBe(await requestHash(base));
    expect(await requestHash({ ...base, payload: { coins: 2, levels: base.payload.levels } })).not.toBe(await requestHash(base));
  });
  it("ignores deviceId and idempotencyKey because they are not part of the input", async () => {
    const a = { game: "g", slot: "s", schemaVersion: 1, baseRevision: 0, payload: {} };
    expect(await requestHash({ ...a, deviceId: "d1" } as never)).toBe(await requestHash(a));
  });
});
