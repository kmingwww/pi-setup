# Guardrail Extension — Implementation Plan

## Structure

Directory-style extension for testability:

```
~/.pi/agent/extensions/guardrail/
├── index.ts                     # Extension entry (thin glue)
├── dangerous-commands.ts        # Pure: pattern matching
├── protected-paths.ts           # Pure: path checking
├── agentignore.ts               # Pure: .agentignore parsing
└── __tests__/
    ├── dangerous-commands.test.ts
    ├── protected-paths.test.ts
    └── agentignore.test.ts
```

Test runner: `node:test` (built into Node.js ≥22, zero dependencies).

---

## Phase 1: Test infrastructure

Create `__tests__/` directory and verify `node:test` runs.

**No production code.**

---

## Phase 2: Dangerous command detection

### 2a — RED: Write tests

File: `__tests__/dangerous-commands.test.ts`

Test `isDangerousCommand(command: string): boolean`:

| Command                        | Expected |
| ------------------------------ | -------- | ------ |
| `rm -rf /tmp/foo`              | `true`   |
| `rm --recursive /tmp/foo`      | `true`   |
| `sudo systemctl restart nginx` | `true`   |
| `chmod 777 script.sh`          | `true`   |
| `chown root:root file`         | `true`   |
| `dd if=/dev/zero of=/dev/sda`  | `true`   |
| `mkfs.ext4 /dev/sdb`           | `true`   |
| `echo "hello" > /dev/null`     | `true`   |
| `:(){ :                        | :& };:`  | `true` |
| `ls -la`                       | `false`  |
| `echo hello`                   | `false`  |
| `git status`                   | `false`  |
| `npm test`                     | `false`  |
| `rm file.txt`                  | `false`  |
| `RMR -RF /tmp`                 | `true`   |
| `rmr -rf /tmp`                 | `false`  |

Verify all fail with `node --test __tests__/dangerous-commands.test.ts`.

### 2b — GREEN: Implement

File: `dangerous-commands.ts`

- Export `DANGEROUS_PATTERNS: RegExp[]` (8 compiled regexes, case-insensitive)
- Export `isDangerousCommand(command: string): boolean`

Minimal: iterate patterns, return `true` on first match.

Verify all pass. Run full test suite.

### 2c — REFACTOR

- Ensure patterns are compiled once (module-level `const`).
- Clean up.

---

## Phase 3: Protected path detection

### 3a — RED: Write tests for hardcoded paths

File: `__tests__/protected-paths.test.ts`

Test `isProtectedPath(path: string, cwd: string): boolean`:

| Path                         | cwd               | Expected                 |
| ---------------------------- | ----------------- | ------------------------ |
| `/home/user/proj/.git/HEAD`  | `/home/user/proj` | `true`                   |
| `/home/user/proj/src/.git`   | `/home/user/proj` | `true` (substring match) |
| `/home/user/proj/.gitignore` | `/home/user/proj` | `false`                  |
| `/home/user/proj/.pi/foo`    | `/home/user/proj` | `true`                   |
| `/home/user/proj/src/bar`    | `/home/user/proj` | `false`                  |
| `/other/proj/.git/config`    | `/home/user/proj` | `true` (absolute path)   |
| `/home/user/.git/config`     | `/home/user/proj` | `true`                   |

Verify all fail.

### 3b — GREEN: Implement hardcoded check

File: `protected-paths.ts`

- `ALWAYS_PROTECTED = [".git/", ".pi/"]`
- `isProtectedPath(path, cwd)` does substring match against absolute or relative path.

Verify all pass.

### 3c — RED: Write tests for .agentignore

Add to `__tests__/protected-paths.test.ts`:

Test `findAgentIgnoreFile(cwd: string): string | null`:

| cwd contains                  | Expected                   |
| ----------------------------- | -------------------------- |
| `.agentignore` in cwd         | returns path to file       |
| `.agentignore` in parent      | returns path to file       |
| no `.agentignore`             | `null`                     |
| `.agentignore` above git root | `null` (stops at git root) |

Test `parseAgentIgnore(content: string): { include: string[]; exclude: string[] }`:

```
Input:
  .env
  .env.*
  !*.env.example
  # comment
  node_modules/

Expected:
  include: [".env", ".env.*", "node_modules/"]
  exclude: ["*.env.example"]
```

Test `isProtectedByAgentIgnore(path, patterns, baseDir): boolean`:

```
baseDir: /proj
patterns.include: ["*.env", "node_modules/"]
patterns.exclude: ["*.env.example"]

/proj/.env          → true
/proj/.env.prod     → false (no pattern matches unless .env.*)
/proj/.env.example  → false (excluded)
/proj/node_modules/foo → true
/proj/src/file.ts   → false
```

Verify all fail.

### 3d — GREEN: Implement .agentignore

File: `agentignore.ts`

- `findAgentIgnoreFile(cwd)` — walk up to git root / filesystem root
- `parseAgentIgnore(content)` — parse gitignore-like syntax, return include/exclude lists
- `isProtectedByAgentIgnore(path, patterns, baseDir)` — match path against patterns, respecting `!` negations

Integrate into `isProtectedPath()` in `protected-paths.ts`.

Verify all pass.

### 3e — REFACTOR

- Ensure `.agentignore` is read once per `tool_call`, not per path check.
- Clean up.

---

## Phase 4: Extension glue

File: `index.ts`

```typescript
import { isDangerousCommand } from "./dangerous-commands";
import { isProtectedPath } from "./protected-paths";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // Bash guardrail
    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (isDangerousCommand(command)) {
        if (ctx.hasUI) {
          const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, [
            "Yes",
            "No",
          ]);
          if (choice !== "Yes") {
            return { block: true, reason: "Blocked by user" };
          }
        } else {
          return { block: true, reason: "Dangerous command blocked (no UI)" };
        }
      }
    }

    // Path guardrail
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = event.input.path as string;
      if (isProtectedPath(path, ctx.cwd)) {
        ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
        return { block: true, reason: "Path is protected" };
      }
    }
  });
}
```

**Manual smoke test** — load with `pi -e ~/.pi/agent/extensions/guardrail/index.ts` and verify prompts appear.

---

## Phase 5: Install

- Move to auto-discovered location: `~/.pi/agent/extensions/guardrail/`
- Restart pi or `/reload`
- Verify it loads without errors

---

## Implementation Order

```
Phase 1: Test infrastructure        (no code)
Phase 2: dangerous-commands.test.ts  → RED
Phase 2: dangerous-commands.ts       → GREEN → REFACTOR
Phase 3: protected-paths.test.ts     → RED
Phase 3: protected-paths.ts          → GREEN (hardcoded only)
Phase 3: agentignore.test.ts         → RED
Phase 3: agentignore.ts              → GREEN → REFACTOR
Phase 3: protected-paths.ts          → GREEN (integrate agentignore) → REFACTOR
Phase 4: index.ts                    (thin glue, manual smoke)
Phase 5: Install                     (move to auto-discover location)
```
