import { describe, it, expect } from "vitest";
import { isProtectedPath, ALWAYS_PROTECTED } from "../../extensions/guardrail/protected-paths";

describe("isProtectedPath", () => {
  const CWD = "/home/user/proj";

  describe("hardcoded protected paths (.git/ and .pi/)", () => {
    it("blocks paths containing .git/", () => {
      expect(isProtectedPath("/home/user/proj/.git/HEAD", CWD)).toBe(true);
      expect(isProtectedPath("/home/user/proj/.git/config", CWD)).toBe(true);
      expect(isProtectedPath("/home/user/proj/src/.git/refs", CWD)).toBe(true);
    });

    it("blocks paths containing .pi/", () => {
      expect(isProtectedPath("/home/user/proj/.pi/foo", CWD)).toBe(true);
      expect(isProtectedPath("/home/user/proj/.pi/settings.json", CWD)).toBe(true);
      expect(isProtectedPath("/home/user/proj/src/.pi/bar", CWD)).toBe(true);
    });

    it("blocks absolute paths outside cwd that contain protected dirs", () => {
      expect(isProtectedPath("/other/proj/.git/config", CWD)).toBe(true);
      expect(isProtectedPath("/home/user/.git/config", CWD)).toBe(true);
    });

    it("does not block paths without protected dirs", () => {
      expect(isProtectedPath("/home/user/proj/src/bar", CWD)).toBe(false);
      expect(isProtectedPath("/home/user/proj/.gitignore", CWD)).toBe(false);
      expect(isProtectedPath("/home/user/proj/README.md", CWD)).toBe(false);
    });

    it("does not false-positive on paths containing .git or .pi as substrings in filenames", () => {
      // "digit" contains "git" but isn't .git/
      expect(isProtectedPath("/home/user/proj/src/digit.ts", CWD)).toBe(false);
      // "spinner" contains "pi" but isn't .pi/
      expect(isProtectedPath("/home/user/proj/src/spinner.ts", CWD)).toBe(false);
    });

    it("handles relative paths", () => {
      expect(isProtectedPath(".git/HEAD", CWD)).toBe(true);
      expect(isProtectedPath("./.git/HEAD", CWD)).toBe(true);
      expect(isProtectedPath(".pi/config", CWD)).toBe(true);
      expect(isProtectedPath("src/main.ts", CWD)).toBe(false);
    });
  });

  describe("ALWAYS_PROTECTED constant", () => {
    it("contains exactly .git/ and .pi/", () => {
      expect(ALWAYS_PROTECTED).toEqual([".git/", ".pi/"]);
    });
  });
});
