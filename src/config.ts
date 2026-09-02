import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const BreakpointSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
});

const SiteConfigSchema = z.object({
  /** Per-site tier overrides, keyed by post type / taxonomy slug. */
  tiers: z
    .object({
      A: z.array(z.string()).optional(),
      B: z.array(z.string()).optional(),
      C: z.array(z.string()).optional(),
    })
    .optional(),
  /** CSS selectors painted over after layout (first-party churning content). */
  mask: z.array(z.string()).optional(),
  /** CSS selectors removed from layout entirely (third-party embeds). */
  hide: z.array(z.string()).optional(),
  /** URL substrings blocked during capture (chat widgets, ad scripts). */
  blockUrls: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  breakpoints: z
    .array(BreakpointSchema)
    .default([
      { name: 'mobile', width: 390 },
      { name: 'tablet', width: 768 },
      { name: 'desktop', width: 1440 },
    ]),
  /**
   * Concurrent page loads. robots.txt on every target site declares
   * Crawl-delay: 10; that is deliberately not honored because these are
   * first-party sites and obeying it would add 2+ hours of pure waiting to a
   * full pass. Lower this if WP Engine or Cloudflare starts throttling.
   */
  concurrency: z.number().int().positive().default(3),
  /** Fraction of changed pixels above which a page/breakpoint is flagged. */
  diffThreshold: z.number().positive().default(0.001),
  /** Runs retained per host before the oldest are pruned. */
  retainRuns: z.number().int().positive().default(5),
  sites: z.record(SiteConfigSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type SiteConfig = z.infer<typeof SiteConfigSchema>;

export async function loadConfig(path = 'scanner.config.json'): Promise<Config> {
  try {
    const raw = await readFile(path, 'utf8');
    return ConfigSchema.parse(JSON.parse(raw));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return ConfigSchema.parse({});
    throw new Error(`Invalid ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Config for one host, falling back to empty. Matches with and without www. */
export function siteConfig(config: Config, origin: string): SiteConfig {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    host = origin;
  }
  const bare = host.replace(/^www\./i, '');
  return config.sites[host] ?? config.sites[bare] ?? {};
}
