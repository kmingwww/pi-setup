import { describe, it, expect } from "vitest";
import { isProtectedPath } from "../../extensions/guardrail/protected-paths";
import { DEFAULT_ALWAYS_PROTECTED } from "../../extensions/guardrail/types";

describe("isProtectedPath", () => {
  describe("hardcoded protected paths (.git/ and .pi/)", () => {
    it("blocks paths containing .git/ as a segment", () => {
      expect(isProtectedPath("/home/user/proj/.git/HEAD")).toBe(true);
      expect(isProtectedPath("/home/user/proj/.git/config")).toBe(true);
      expect(isProtectedPath("/home/user/proj/src/.git/refs")).toBe(true);
    });

    it("blocks paths containing .pi/ as a segment", () => {
      expect(isProtectedPath("/home/user/proj/.pi/foo")).toBe(true);
      expect(isProtectedPath("/home/user/proj/.pi/settings.json")).toBe(true);
      expect(isProtectedPath("/home/user/proj/src/.pi/bar")).toBe(true);
    });

    it("blocks paths outside cwd that contain protected dirs", () => {
      expect(isProtectedPath("/other/proj/.git/config")).toBe(true);
      expect(isProtectedPath("/home/user/.git/config")).toBe(true);
    });

    it("does not block paths without protected dirs", () => {
      expect(isProtectedPath("/home/user/proj/src/bar")).toBe(false);
      expect(isProtectedPath("/home/user/proj/.gitignore")).toBe(false);
      expect(isProtectedPath("/home/user/proj/README.md")).toBe(false);
    });

    it("does not false-positive on paths containing .git or .pi as substrings in filenames", () => {
      // "digit" contains "git" but isn't .git/ as a segment
      expect(isProtectedPath("/home/user/proj/src/digit.ts")).toBe(false);
      // "spinner" contains "pi" but isn't .pi/ as a segment
      expect(isProtectedPath("/home/user/proj/src/spinner.ts")).toBe(false);
    });

    it("handles paths that ARE .git as a segment (trailing content implied)", () => {
      expect(isProtectedPath("/home/user/proj/.git")).toBe(true);
    });
  });

  describe("DEFAULT_ALWAYS_PROTECTED constant", () => {
    it("contains exactly .git/ and .pi/", () => {
      expect(DEFAULT_ALWAYS_PROTECTED).toEqual([".git/", ".pi/"]);
    });
  });
});
