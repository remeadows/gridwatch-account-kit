import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidV4 } from "../src/saves/uuid";
import { UUID_RE } from "../src/saves-schema/wire";

afterEach(() => vi.unstubAllGlobals());

describe("uuidV4", () => {
  it("produces a v4 UUID matching the wire UUID_RE", () => {
    const id = uuidV4();
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe("4"); // version nibble
  });
  it("falls back to a getRandomValues-based v4 when crypto.randomUUID is unavailable", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real), randomUUID: undefined });
    const id = uuidV4();
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe("4");
  });
  it("throws a clear error instead of a ReferenceError when crypto is missing entirely", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => uuidV4()).toThrow("[account-kit] crypto.getRandomValues is required for cloud saves");
  });
});
