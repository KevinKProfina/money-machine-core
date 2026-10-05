import fsp from 'node:fs/promises';
import path from 'node:path';
import type { StudioConfig } from './config.js';
import { formatPrice, renderCatalog, renderDatenschutz, renderImpressum, renderLanding, renderRobots, renderSitemap, type LandingMode } from './html.js';
import type { Venture } from './types.js';

export const LIVE_STATES = new Set(['live', 'winner']);

/** Ventures that ever went public (live, winner, or killed after publishing). */
export function publishedVentures(ventures: Venture[]): Venture[] {
  return ventures.filter((v) => v.publish?.publishedAt && (LIVE_STATES.has(v.state) || v.state === 'killed'));
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
      renderLanding(v, v.build.copy, { mode, buyUrl: v.publish.stripe?.paymentLinkUrl, siteUrl: cfg.siteUrl, operator: cfg.operator, currency: cfg.currency, priceNote: cfg.priceNote }),
    );
    // Download page stays available after a kill so earlier buyers keep access.
    const productHtml = await fsp.readFile(path.join(v.build.dir, 'product.html'), 'utf8');
    await fsp.writeFile(path.join(dir, v.publish.token, 'index.html'), productHtml);
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
    ),
  );
  await fsp.writeFile(path.join(tmp, 'impressum.html'), renderImpressum(cfg.operator));
  await fsp.writeFile(path.join(tmp, 'datenschutz.html'), renderDatenschutz(cfg.operator, channel));
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
