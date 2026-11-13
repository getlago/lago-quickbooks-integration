/**
 * Transforms never throw for bad business data: they return a failure with a message meant for
 * the run summary (and, through SKILL.md, for the bookkeeper). Throwing is reserved for bugs.
 */
export type TransformResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export const ok = <T>(value: T): TransformResult<T> => ({ ok: true, value });
export const fail = <T = never>(reason: string): TransformResult<T> => ({ ok: false, reason });
