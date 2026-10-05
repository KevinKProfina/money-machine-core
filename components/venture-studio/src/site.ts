import fsp from 'node:fs/promises';
import path from 'node:path';
import type { StudioConfig } from './config.js';
import { formatPrice, injectBeacon, renderCatalog, renderDatenschutz, renderImpressum, renderLanding, renderRobots, renderSitemap, type AnalyticsNotice, type BeaconConfig, type LandingMode } from './html.js';
import type { Venture } from './types.js';

export const LIVE_STATES = new Set(['live', 'winner']);

/** Ventures that ever went public (live, winner, or killed after publishing). */
export function publishedVentures(ventures: Venture[]): Venture[] {
  return ventures.filter((v) => v.publish?.publishedAt && (LIVE_STATES.has(v.state) || v.state === 'killed'));
}

/** Beacon settings when analytics is enabled (STUDIO_ANALYTICS_URL + a site id), else undefined. */
export function beaconConfigFor(cfg: StudioConfig): BeaconConfig | undefined {
  if (!cfg.analytics.url || !cfg.analytics.site) return undefined;
  return { endpoint: `${cfg.analytics.url}/e`, site: cfg.analytics.site };
}

export function analyticsNoticeFor(cfg: StudioConfig): AnalyticsNotice | undefined {
  if (!beaconConfigFor(cfg)) return undefined;
  return { collectorHost: new URL(cfg.analytics.url!).host, retentionDays: cfg.analytics.retentionDays };
}

/** Changes whenever the public pages would embed a different (or no) beacon → site rebuild. */
export function beaconSignature(cfg: StudioConfig): string {
  const b = beaconConfigFor(cfg);
  return b ? `${b.endpoint}|${b.site}|${cfg.analytics.retentionDays}` : '';
}

export function landingModeFor(v: Venture): LandingMode {
  if (v.state === 'killed') return 'discontinued';
  if (v.publish?.stripe?.paymentLinkUrl && !v.publish.stripe.deactivated) return 'live';
  return 'coming-soon';
}

/**
 * Rebuild the whole public site from state. Only ventures that passed the owner's
 * approval and were published appear; previews never live in the site dir.
 * Written to a temp dir and swapped in, so a deploy never sees a half-written site.
 */
export async function writeSite(ventures: Venture[], cfg: StudioConfig, siteDir: string, now: Date, channel: 'stripe' | 'none'): Promise<{ live: string[]; discontinued: string[] }> {
  if (!cfg.operator) throw new Error('operator details missing');
  if (!cfg.siteUrl) throw new Error('STUDIO_SITE_URL missing');
  const tmp = `${siteDir}.tmp-${process.pid}-${now.getTime()}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });

  const beacon = beaconConfigFor(cfg);
  const pub = publishedVentures(ventures);
  const live = pub.filter((v) => v.state !== 'killed');
  const discontinued = pub.filter((v) => v.state === 'killed');

  for (const v of pub) {
    if (!v.build?.copy || !v.publish) continue;
    const dir = path.join(tmp, v.slug);
    await fsp.mkdir(path.join(dir, v.publish.token), { recursive: true });
    const mode = landingModeFor(v);
    await fsp.writeFile(
      path.join(dir, 'index.html'),
      renderLanding(v, v.build.copy, { mode, buyUrl: v.publish.stripe?.paymentLinkUrl, siteUrl: cfg.siteUrl, operator: cfg.operator, currency: cfg.currency, priceNote: cfg.priceNote, beacon }),
    );
    // Download page stays available after a kill so earlier buyers keep access.
    // The beacon reports the download under the landing path (/<slug>/), never the token path.
    // Micro-tools promise "no network access", so their download page stays beacon-free.
    const productHtml = await fsp.readFile(path.join(v.build.dir, 'product.html'), 'utf8');
    const download = beacon && v.idea.category !== 'micro-tool' ? injectBeacon(productHtml, beacon, `/${v.slug}/`, 'download') : productHtml;
    await fsp.writeFile(path.join(dir, v.publish.token, 'index.html'), download);
    try {
      await fsp.copyFile(path.join(v.build.dir, 'product.md'), path.join(dir, v.publish.token, `${v.slug}.md`));
    } catch {
      // micro-tools have no markdown
    }
  }

  await fsp.writeFile(
    path.join(tmp, 'index.html'),
    renderCatalog(
      live.map((v) => ({ title: v.title, slug: v.slug, description: v.build?.copy?.metaDescription ?? v.idea.problem, price: formatPrice(v.idea.price, cfg.currency, v.idea.language) })),
      cfg.operator,
      cfg.siteUrl,
      beacon,
    ),
  );
  await fsp.writeFile(path.join(tmp, 'impressum.html'), renderImpressum(cfg.operator));
  await fsp.writeFile(path.join(tmp, 'datenschutz.html'), renderDatenschutz(cfg.operator, channel, analyticsNoticeFor(cfg)));
  await fsp.writeFile(path.join(tmp, 'sitemap.xml'), renderSitemap(cfg.siteUrl, live.map((v) => v.slug), now.toISOString()));
  await fsp.writeFile(path.join(tmp, 'robots.txt'), renderRobots(cfg.siteUrl));

  const old = `${siteDir}.old-${process.pid}-${now.getTime()}`;
  let hadOld = false;
  try {
    await fsp.rename(siteDir, old);
    hadOld = true;
  } catch {
    // first write
  }
  await fsp.rename(tmp, siteDir);
  if (hadOld) await fsp.rm(old, { recursive: true, force: true });
  return { live: live.map((v) => v.slug), discontinued: discontinued.map((v) => v.slug) };
}
