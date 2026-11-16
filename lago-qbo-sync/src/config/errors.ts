/**
 * Raised for any invalid mappings.yaml or environment. The CLI maps it to exit code 2 (brief §4.3).
 *
 * `issues` hold a path and a message only. They never carry the offending value, because the
 * value may be a secret read from the environment.
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly issues: readonly string[];

  constructor(summary: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${summary}\n  - ${issues.join('\n  - ')}` : summary);
    this.issues = issues;
  }
}
