import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, hasLoneSurrogate, requestHash, sha256Hex } from "../src/saves-schema/canonical";

// Reference implementation for the differential test below only — a lookbehind here is fine
// (this file is never shipped; only src/ is scanned by the release gate and the test above).
// Deliberately independent of hasLoneSurrogate's code-unit scan: same semantics, different technique.
const REFERENCE_LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function referenceHasLoneSurrogate(text: string): boolean {
  return REFERENCE_LONE_SURROGATE_RE.test(text);
}

// Small seeded PRNG (mulberry32) so the differential test below is deterministic across runs.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  it("rejects a trailing high surrogate with nothing after it", () => {
    expect(() => canonicalJson("a\uD83D")).toThrow(/canonicalJson: lone surrogate at \$/);
  });
  it("rejects a leading low surrogate with nothing before it", () => {
    expect(() => canonicalJson("\uDE00a")).toThrow(/canonicalJson: lone surrogate at \$/);
  });
  it("rejects a high surrogate immediately followed by a valid surrogate pair (the first one is lone)", () => {
    expect(() => canonicalJson("\uD83D😀")).toThrow(/canonicalJson: lone surrogate at \$/);
  });
  it("accepts a valid surrogate pair in the middle of a longer string", () => {
    expect(() => canonicalJson("before😀after")).not.toThrow();
  });
  it("hasLoneSurrogate agrees with an independent reference implementation across thousands of random strings (differential test)", () => {
    const rand = mulberry32(20260917);
    // 'a' (plain), a lone high surrogate, a lone low surrogate, and a valid pair — random
    // concatenations of these cover lone surrogates in every position (start/middle/end,
    // adjacent to another lone surrogate, adjacent to a valid pair) far more thoroughly than
    // the handful of cases spelled out above.
    const alphabet = ["a", "\uD83D", "\uDE00", "😀"];
    for (let trial = 0; trial < 5000; trial++) {
      const length = Math.floor(rand() * 8);
      let s = "";
      for (let i = 0; i < length; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      expect(hasLoneSurrogate(s), `mismatch for ${JSON.stringify(s)}`).toBe(referenceHasLoneSurrogate(s));
    }
  });
  it("builds without a regex lookbehind anywhere under saves-schema/, so the module still parses on engines that lack it (e.g. Safari < 16.4)", () => {
    // This scans the src/ sources — where lookbehind syntax would fail to parse at all — not the
    // built dist/ output; check:dist proves a fresh build matches what's committed to dist/, so a
    // clean scan of src/ is sufficient without also walking dist/.
    const dir = fileURLToPath(new URL("../src/saves-schema/", import.meta.url));
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(`${dir}${name}`, "utf8");
      expect(source, `${name} contains a lookbehind`).not.toMatch(/\(\?<[!=]/);
    }
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
