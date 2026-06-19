/**
 * Detects dangerous bash commands using regex patterns.
 *
 * These patterns are compiled once at module load and tested against
 * the command string with `test()`. Each pattern targets a specific
 * class of dangerous shell invocation.
 */

/**
 * All patterns are case-insensitive.
 * Order is arbitrary; `isDangerousCommand` returns `true` on first match.
 */
export const DANGEROUS_PATTERNS: RegExp[] = [
  // rm with -r, -f, or --recursive flags
  /\brm\s+(?:-[a-z]*[rf][a-z]*\b|--recursive)/i,
  // sudo
  /\bsudo\b/i,
  // chmod 777 (any variant)
  /\bchmod\b.*777/i,
  // chown
  /\bchown\b/i,
  // redirect to /dev/ files (exclude safe pseudo-devices: null, zero, random,
  // urandom, full, stderr, stdout, stdin, fd/)
  />\s*\/dev\/(?!null\b|zero\b|random\b|urandom\b|full\b|stderr\b|stdout\b|stdin\b|fd\/)/i,
  // mkfs (filesystem creation)
  /\bmkfs\b/i,
  // dd with if= (disk imaging)
  /\bdd\s+if=/i,
  // fork bomb — match the literal string of special characters
  /:\(\)\{\s*:\|:&\s*\};:/i,
];

/**
 * Returns `true` if the command matches any of the dangerous patterns.
 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}
