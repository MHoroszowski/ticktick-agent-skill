/**
 * reminders.ts — pure helpers for converting between human-friendly
 * reminder offset strings and the RFC-5545-style TRIGGER duration strings
 * TickTick uses internally.
 *
 * Lives outside src/commands/ so both `output.ts` (for table formatting)
 * and `commands/tasks.ts` (for CLI input parsing) can import without
 * creating a circular dependency.
 *
 * Sign convention: TickTick uses UNSIGNED durations to mean "before the
 * task's scheduled time". `TRIGGER:PT15M` is "15 minutes BEFORE due".
 * Verified against the live API on 2026-04-12 — see
 * scripts/probe-reminders.ts.
 */

import { UsageError } from './errors.ts';

/**
 * Parse a human-friendly reminder offset into a TRIGGER duration string.
 *
 * Accepted inputs:
 *   - 'at-start' or '0'         → TRIGGER:PT0S
 *   - '5m', '15m', '30m'        → TRIGGER:PT5M etc.
 *   - '1h', '2h'                → TRIGGER:PT1H etc.
 *   - '1d', '7d'                → TRIGGER:P1D etc.
 *   - '1d9h', '2d3h45m'         → TRIGGER:P1DT9H, TRIGGER:P2DT3H45M (combined)
 *   - 'TRIGGER:...'             → returned as-is (raw passthrough escape hatch)
 */
export function parseTriggerOffset(input: string): string {
  if (input.startsWith('TRIGGER:')) return input;
  if (input === 'at-start' || input === '0') return 'TRIGGER:PT0S';
  const m = input.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || m.slice(1).every((v) => v === undefined)) {
    throw new UsageError(
      `--remind expected formats: at-start, 15m, 1h, 1d, 1d9h, or raw TRIGGER:... — got: ${input}`,
    );
  }
  const [, d, h, mn, s] = m;
  const date = d ? `${d}D` : '';
  const time =
    h || mn || s
      ? `T${h ? `${h}H` : ''}${mn ? `${mn}M` : ''}${s ? `${s}S` : ''}`
      : '';
  if (date === '' && time === '') return 'TRIGGER:PT0S';
  return `TRIGGER:P${date}${time}`;
}

/**
 * Inverse of parseTriggerOffset for human display. Compact form. Returns
 * the input verbatim if it doesn't match a recognized TRIGGER shape, so
 * server-side novel formats degrade gracefully.
 */
export function formatTriggerOffset(trigger: string): string {
  if (trigger === 'TRIGGER:PT0S') return 'at-start';
  // Tolerate optional leading minus for forward-compat — TickTick currently
  // uses unsigned but RFC 5545 allows the sign and other clients might.
  const m = trigger.match(/^TRIGGER:-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return trigger;
  const [, d, h, mn, s] = m;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (mn) parts.push(`${mn}m`);
  if (s) parts.push(`${s}s`);
  return parts.length > 0 ? parts.join('') : trigger;
}
