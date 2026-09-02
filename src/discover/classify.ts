import type { EntryKind, Tier } from '../types.js';

/**
 * Tier assignment.
 *
 *   A  primary content         capture, ranked first
 *   B  thin / auxiliary CPTs   capture, ranked lower
 *   C  churn + archives        LINK-CHECKED ONLY, never captured
 *
 * Tier C is driven by structure wherever possible -- taxonomy archives, author
 * archives and calendar-plugin post types -- because type NAMES vary per site.
 * Reconnaissance found the churn types are tribe_events/tribe_venue on
 * campwareagle, but streamitem/ozrday/ozrsession on campotx; a single hardcoded
 * name list would be wrong on nearly every site. On the two large sites these
 * account for 81-84% of all URLs, so getting this wrong dominates run cost.
 */

/** Calendar/event plugin prefixes. Structural: these are always churn. */
const CHURN_PREFIXES = [/^tribe_/i, /^tec_/i];

/**
 * Site-specific churn types found during reconnaissance. Unlike the prefixes
 * above these are a name list, so they are only DEFAULTS -- override per site
 * in scanner.config.json once `scan --discover-only` shows the real breakdown.
 */
const CHURN_TYPES = new Set(['streamitem', 'ozrday', 'ozrsession', 'busdeparture']);

/** Thin or auxiliary content: real pages, but low-value in bulk. */
const AUXILIARY_TYPES = new Set([
  'cards', 'pcomponent', 'olifaqs', 'quicklinks', 'resource', 'vshow',
  'testimonial', 'testimonials', 'awards', 'job_position', 'ozryear',
  'opening-day', 'closing-day', 'closing-day-ceremony', 'session',
  'registration', 'syndication',
]);

export interface TierOverrides {
  A?: string[];
  B?: string[];
  C?: string[];
}

export function assignTier(type: string, kind: EntryKind, overrides: TierOverrides = {}): Tier {
  // Explicit config always wins.
  if (overrides.A?.includes(type)) return 'A';
  if (overrides.B?.includes(type)) return 'B';
  if (overrides.C?.includes(type)) return 'C';

  // Structural: archives are never reviewable pages in their own right.
  if (kind === 'taxonomy' || kind === 'user') return 'C';

  if (CHURN_PREFIXES.some((re) => re.test(type)) || CHURN_TYPES.has(type)) return 'C';
  if (AUXILIARY_TYPES.has(type)) return 'B';
  return 'A';
}

/** Tiers whose URLs get screenshotted. Everything else is link-checked only. */
export const CAPTURE_TIERS: Tier[] = ['A', 'B'];

export function isCaptured(tier: Tier): boolean {
  return CAPTURE_TIERS.includes(tier);
}
