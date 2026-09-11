import { describe, expect, it } from "vitest";
import { HANDLE_RE, validateHandle } from "../src/handle";

describe("validateHandle", () => {
  it("accepts valid handles", () => {
    expect(validateHandle("abc")).toBe(null);
    expect(validateHandle("a-b_C9")).toBe(null);
  });

  it("rejects empty string", () => {
    expect(validateHandle("")).toBe("Handle must be 1-12 characters: letters, numbers, _ or -.");
  });

  it("rejects too long handles", () => {
    expect(validateHandle("thirteen-char")).toBe("Handle must be 1-12 characters: letters, numbers, _ or -.");
  });

  it("rejects handles with invalid characters", () => {
    expect(validateHandle("bad space")).toBe("Handle must be 1-12 characters: letters, numbers, _ or -.");
    expect(validateHandle("ünï")).toBe("Handle must be 1-12 characters: letters, numbers, _ or -.");
  });
});

describe("HANDLE_RE", () => {
  it("matches exactly 12 characters", () => {
    expect(HANDLE_RE.test("x".repeat(12))).toBe(true);
  });

  it("rejects 13 characters", () => {
    expect(HANDLE_RE.test("x".repeat(13))).toBe(false);
  });
});
