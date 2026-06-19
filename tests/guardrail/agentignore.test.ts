import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentIgnorePatterns } from "../../extensions/guardrail/agentignore";

// ---------------------------------------------------------------------------
// Mock node:fs for findAgentIgnoreFile tests
// ---------------------------------------------------------------------------

const mockedExistsSync = vi.fn();

vi.mock("node:fs", () => ({
  default: { existsSync: (p: string) => mockedExistsSync(p) },
  existsSync: (p: string) => mockedExistsSync(p),
}));

import {
  findAgentIgnoreFile,
  parseAgentIgnore,
  isProtectedByAgentIgnore,
} from "../../extensions/guardrail/agentignore";

// ---------------------------------------------------------------------------
// findAgentIgnoreFile
// ---------------------------------------------------------------------------

describe("findAgentIgnoreFile", () => {
  beforeEach(() => {
    mockedExistsSync.mockReset();
  });

  const CWD = "/home/user/proj";
  const SRC = "/home/user/proj/src";
  it("returns the path when .agentignore exists in cwd and no .git/ ancestor", () => {
    // existsSync called for: .agentignore (yes) in cwd
    mockedExistsSync.mockImplementation((p: string) => p === "/home/user/proj/.agentignore");

    const result = findAgentIgnoreFile(CWD);
    expect(result).toBe("/home/user/proj/.agentignore");
  });

  it("returns the path when .agentignore exists in a parent directory", () => {
    mockedExistsSync.mockImplementation((p: string) => {
      if (p === "/home/user/proj/src/.agentignore") return false;
      if (p === "/home/user/proj/src/.git") return false;
      if (p === "/home/user/proj/.agentignore") return true;
      return false;
    });

    const result = findAgentIgnoreFile(SRC);
    expect(result).toBe("/home/user/proj/.agentignore");
  });

  it("returns null when no .agentignore exists anywhere up the tree", () => {
    mockedExistsSync.mockReturnValue(false);

    const result = findAgentIgnoreFile(CWD);
    expect(result).toBeNull();
  });

  it("stops at git root (directory containing .git/)", () => {
    mockedExistsSync.mockImplementation((p: string) => {
      if (p === "/home/user/proj/src/.agentignore") return false;
      if (p === "/home/user/proj/src/.git") return false;
      if (p === "/home/user/proj/.agentignore") return false;
      if (p === "/home/user/proj/.git") return true; // git root — stop here
      return false;
    });

    const result = findAgentIgnoreFile(SRC);
    // Should stop at git root even though /home/user might have .agentignore
    expect(result).toBeNull();
  });

  it("stops at the filesystem root if no git root", () => {
    mockedExistsSync.mockReturnValue(false);

    const result = findAgentIgnoreFile("/foo/bar/baz");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseAgentIgnore
// ---------------------------------------------------------------------------

describe("parseAgentIgnore", () => {
  it("parses simple patterns", () => {
    const content = ".env\nnode_modules/\n";
    const result = parseAgentIgnore(content);
    expect(result.include).toEqual([".env", "node_modules/"]);
    expect(result.exclude).toEqual([]);
  });

  it("handles negation patterns (!)", () => {
    const content = ".env\n.env.*\n!*.env.example\nnode_modules/";
    const result = parseAgentIgnore(content);
    expect(result.include).toEqual([".env", ".env.*", "node_modules/"]);
    expect(result.exclude).toEqual(["*.env.example"]);
  });

  it("ignores comments and blank lines", () => {
    const content =
      "# Environment files\n.env\n\n# Node modules\nnode_modules/\n\n# But allow example env\n!*.env.example\n";
    const result = parseAgentIgnore(content);
    expect(result.include).toEqual([".env", "node_modules/"]);
    expect(result.exclude).toEqual(["*.env.example"]);
  });

  it("trims whitespace from patterns", () => {
    const content = "  .env  \n  node_modules/  ";
    const result = parseAgentIgnore(content);
    expect(result.include).toEqual([".env", "node_modules/"]);
    expect(result.exclude).toEqual([]);
  });

  it("handles empty input", () => {
    const result = parseAgentIgnore("");
    expect(result.include).toEqual([]);
    expect(result.exclude).toEqual([]);
  });

  it("handles input with only comments and blank lines", () => {
    const content = "# nothing\n# to see\n";
    const result = parseAgentIgnore(content);
    expect(result.include).toEqual([]);
    expect(result.exclude).toEqual([]);
  });

  it("treats inline comments as literal patterns (like .gitignore)", () => {
    const content = ".env  # production vars\nnode_modules/  # dependencies";
    const result = parseAgentIgnore(content);
    expect(result.include).toEqual([".env  # production vars", "node_modules/  # dependencies"]);
    expect(result.exclude).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isProtectedByAgentIgnore
// ---------------------------------------------------------------------------

describe("isProtectedByAgentIgnore", () => {
  const BASE_DIR = "/home/user/proj";

  const patterns: AgentIgnorePatterns = {
    include: [".env", "*.pem", "node_modules/", "secrets/"],
    exclude: ["*.env.example"],
  };

  it("blocks exact filename matches", () => {
    expect(isProtectedByAgentIgnore("/home/user/proj/.env", patterns, BASE_DIR)).toBe(true);
  });

  it("blocks directory matches", () => {
    expect(
      isProtectedByAgentIgnore("/home/user/proj/node_modules/foo/bar.js", patterns, BASE_DIR),
    ).toBe(true);
  });

  it("allows files excluded by negation patterns", () => {
    expect(isProtectedByAgentIgnore("/home/user/proj/.env.example", patterns, BASE_DIR)).toBe(
      false,
    );
  });

  it("allows files that don't match any pattern", () => {
    expect(isProtectedByAgentIgnore("/home/user/proj/src/file.ts", patterns, BASE_DIR)).toBe(false);
  });

  it("matches wildcard patterns (*)", () => {
    expect(isProtectedByAgentIgnore("/home/user/proj/cert.pem", patterns, BASE_DIR)).toBe(true);
    expect(isProtectedByAgentIgnore("/home/user/proj/secrets/prod.key", patterns, BASE_DIR)).toBe(
      true,
    );
  });

  it("handles relative paths", () => {
    // .env resolves to /home/user/proj/.env
    expect(isProtectedByAgentIgnore(".env", patterns, BASE_DIR)).toBe(true);
    expect(isProtectedByAgentIgnore("./.env", patterns, BASE_DIR)).toBe(true);
  });

  it("handles empty patterns", () => {
    const empty: AgentIgnorePatterns = { include: [], exclude: [] };
    expect(isProtectedByAgentIgnore("/home/user/proj/.env", empty, BASE_DIR)).toBe(false);
  });
});
