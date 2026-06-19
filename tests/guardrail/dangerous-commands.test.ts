import { describe, it, expect } from "vitest";
import {
  isDangerousCommand,
  ALL_PATTERNS as DANGEROUS_PATTERNS,
} from "../../extensions/guardrail/dangerous-commands";

describe("isDangerousCommand", () => {
  describe("dangerous commands — should return true", () => {
    it.each([
      "rm -rf /tmp/foo",
      "rm -r /tmp/foo",
      "rm --recursive /tmp/foo",
      "rm -rf --no-preserve-root /",
    ])("detects rm dangerous variants: %s", (command) => {
      expect(isDangerousCommand(command)).toBe(true);
    });

    it("detects sudo", () => {
      expect(isDangerousCommand("sudo systemctl restart nginx")).toBe(true);
      expect(isDangerousCommand("sudo rm -rf /etc/nginx")).toBe(true);
    });

    it("detects chmod 777", () => {
      expect(isDangerousCommand("chmod 777 script.sh")).toBe(true);
      expect(isDangerousCommand("chmod -R 777 /var/www")).toBe(true);
    });

    it("detects chown", () => {
      expect(isDangerousCommand("chown root:root file")).toBe(true);
      expect(isDangerousCommand("chown -R user:group /home")).toBe(true);
    });

    it("detects redirect to block device files", () => {
      expect(isDangerousCommand("cat file > /dev/sda")).toBe(true);
      expect(isDangerousCommand("cat file > /dev/nvme0n1")).toBe(true);
    });

    it("detects mkfs (filesystem formatting)", () => {
      expect(isDangerousCommand("mkfs.ext4 /dev/sdb")).toBe(true);
      expect(isDangerousCommand("mkfs -t ext4 /dev/sda1")).toBe(true);
    });

    it("detects dd disk imaging", () => {
      expect(isDangerousCommand("dd if=/dev/zero of=/dev/sda")).toBe(true);
      expect(isDangerousCommand("dd if=/dev/urandom of=file bs=1M count=100")).toBe(true);
    });

    it("detects fork bomb", () => {
      expect(isDangerousCommand(":(){ :|:& };:")).toBe(true);
      expect(isDangerousCommand(" :(){ :|:& };: ")).toBe(true);
    });

    it("detects case-insensitive matches", () => {
      expect(isDangerousCommand("RM -RF /tmp/foo")).toBe(true);
      expect(isDangerousCommand("SUDO ls")).toBe(true);
      expect(isDangerousCommand("Chmod 777 script")).toBe(true);
    });
  });

  describe("safe commands — should return false", () => {
    it.each([
      "ls -la",
      "echo hello",
      "git status",
      "npm test",
      "rm file.txt", // rm without -r or -f flags
      "mkdir -p /tmp/foo",
      "cp file.txt backup.txt",
      "mv old new",
      "find . -name '*.ts'",
      "grep -r 'pattern' src/",
      "cat README.md",
      "curl https://example.com",
      "wget https://example.com/file.tar.gz",
      "node --version",
      "python script.py",
      "docker ps",
      "systemctl status nginx", // no sudo
    ])("passes safe command: %s", (command) => {
      expect(isDangerousCommand(command)).toBe(false);
    });

    it("does not flag rm without dangerous flags", () => {
      expect(isDangerousCommand("rm file.txt")).toBe(false);
    });

    it("does not flag rmr (non-standard command)", () => {
      expect(isDangerousCommand("rmr -rf /tmp")).toBe(false);
    });

    it("does not flag redirect to safe pseudo-devices", () => {
      expect(isDangerousCommand('echo "hello" > /dev/null')).toBe(false);
      expect(isDangerousCommand("echo 'hello' 2>/dev/null")).toBe(false);
      expect(isDangerousCommand("cmd >/dev/null 2>&1")).toBe(false);
      expect(isDangerousCommand("> /dev/zero")).toBe(false);
      expect(isDangerousCommand("> /dev/random")).toBe(false);
      expect(isDangerousCommand("> /dev/urandom")).toBe(false);
      expect(isDangerousCommand("> /dev/full")).toBe(false);
      expect(isDangerousCommand("> /dev/stderr")).toBe(false);
      expect(isDangerousCommand("> /dev/stdout")).toBe(false);
      expect(isDangerousCommand("> /dev/stdin")).toBe(false);
      expect(isDangerousCommand("> /dev/fd/3")).toBe(false);
    });
  });

  describe("DANGEROUS_PATTERNS", () => {
    it("has 9 compiled regex patterns (7 restricted + 2 elevated)", () => {
      expect(DANGEROUS_PATTERNS).toHaveLength(9);
      for (const entry of DANGEROUS_PATTERNS) {
        expect(entry.regex).toBeInstanceOf(RegExp);
        expect(entry.regex.flags).toContain("i"); // case-insensitive
      }
    });
  });
});
