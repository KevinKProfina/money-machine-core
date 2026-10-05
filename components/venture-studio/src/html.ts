import { Marked } from 'marked';
import type { Operator } from './config.js';
import type { LandingCopy, Venture } from './types.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Markdown → HTML. Raw HTML inside the Markdown is escaped (no scripts from generated content). */
const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false });
  // links: only http(s)/mailto/anchors survive
  return html.replace(/href="(?!https?:|mailto:|#)[^"]*"/gi, 'href="#"');
}

export function formatPrice(price: number, currency: string, lang: 'de' | 'en'): string {
  return new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-IE', { style: 'currency', currency: currency.toUpperCase() }).format(price);
}

const CSS = `:root{--fg:#1d1d1f;--muted:#5f6368;--bg:#fff;--card:#f6f7f9;--accent:#0b57d0;--border:#e2e4e8}
@media (prefers-color-scheme:dark){:root{--fg:#ececec;--muted:#a8adb4;--bg:#141517;--card:#1e2023;--accent:#8ab4f8;--border:#33363b}}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
main,header,footer{max-width:760px;margin:0 auto;padding:0 16px}header{padding-top:32px}h1{font-size:2rem;line-height:1.2;margin:.2em 0}
.sub{color:var(--muted);font-size:1.15rem}.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin:20px 0}
.buy{display:inline-block;background:var(--accent);color:var(--bg);padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600}
.buy.disabled{opacity:.55;pointer-events:none}.price{font-size:1.6rem;font-weight:700}.note{font-size:.85rem;color:var(--muted)}
footer{margin-top:48px;padding-bottom:32px;border-top:1px solid var(--border);font-size:.85rem;color:var(--muted)}footer a{color:inherit}
table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--border);padding:6px 8px;text-align:left}pre{overflow-x:auto}`;

export function page(opts: { lang: 'de' | 'en'; title: string; head?: string; body: string; noindex?: boolean }): string {
  return `<!doctype html>
<html lang="${opts.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
${opts.noindex ? '<meta name="robots" content="noindex, nofollow">\n' : ''}${opts.head ?? ''}
<style>${CSS}</style>
</head>
<body>
${opts.body}
</body>
</html>
`;
}

const T = {
  de: {
    buy: 'Jetzt kaufen',
    preview: 'Kauf-Button (Vorschau – erst nach Freigabe aktiv)',
    soon: 'Bald verfügbar',
    discontinued: 'Dieses Produkt ist nicht mehr erhältlich.',
    benefits: 'Das bekommst du',
    outline: 'Inhalt',
    faq: 'Häufige Fragen',
    ai: 'Hinweis: Dieses Produkt wurde KI-gestützt erstellt (AI-assisted) und vor der Veröffentlichung automatisiert sowie vom Betreiber geprüft.',
    imprint: 'Impressum',
    privacy: 'Datenschutz',
    catalog: 'Alle Produkte',
  },
  en: {
    buy: 'Buy now',
    preview: 'Buy button (preview – active only after approval)',
    soon: 'Coming soon',
    discontinued: 'This product has been discontinued.',
    benefits: 'What you get',
    outline: 'Contents',
    faq: 'FAQ',
    ai: 'Notice: this product was created with AI assistance (AI-assisted) and reviewed automatically and by the operator before publication.',
    imprint: 'Imprint (Impressum)',
    privacy: 'Privacy (Datenschutz)',
    catalog: 'All products',
  },
} as const;

export const WITHDRAWAL_NOTICE_DE =
  'Widerrufsrecht bei digitalen Inhalten: Mit dem Kauf verlangst du ausdrücklich, dass wir vor Ablauf der Widerrufsfrist mit der Vertragsausführung beginnen (sofortige Bereitstellung des Downloads). Dir ist bekannt, dass du dadurch dein Widerrufsrecht verlierst (§ 356 Abs. 5 BGB).';
export const WITHDRAWAL_NOTICE_EN =
  '(English: For digital content, by purchasing you expressly request immediate delivery before the end of the withdrawal period and acknowledge that you thereby lose your right of withdrawal.)';

export type LandingMode = 'preview' | 'live' | 'coming-soon' | 'discontinued';

export type LandingCtx = {
  mode: LandingMode;
  buyUrl?: string;
  siteUrl?: string;
  operator?: Operator;
  currency: string;
  priceNote: string;
};

export function renderLanding(v: Pick<Venture, 'slug' | 'title' | 'idea'>, copy: LandingCopy, ctx: LandingCtx): string {
  const lang = v.idea.language;
  const t = T[lang];
  const url = ctx.siteUrl ? `${ctx.siteUrl}/${v.slug}/` : undefined;
  const price = formatPrice(v.idea.price, ctx.currency, lang);
  const availability =
    ctx.mode === 'live' ? 'https://schema.org/InStock' : ctx.mode === 'discontinued' ? 'https://schema.org/Discontinued' : 'https://schema.org/PreOrder';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: v.title,
    description: copy.metaDescription,
    category: v.idea.productType,
    offers: { '@type': 'Offer', price: v.idea.price.toFixed(2), priceCurrency: ctx.currency.toUpperCase(), availability, ...(url ? { url } : {}) },
  };
  const head = [
    `<meta name="description" content="${escapeHtml(copy.metaDescription)}">`,
    `<meta name="keywords" content="${escapeHtml(v.idea.keywords.join(', '))}">`,
    url ? `<link rel="canonical" href="${escapeHtml(url)}">` : '',
    `<meta property="og:type" content="product">`,
    `<meta property="og:title" content="${escapeHtml(copy.headline)}">`,
    `<meta property="og:description" content="${escapeHtml(copy.metaDescription)}">`,
    url ? `<meta property="og:url" content="${escapeHtml(url)}">` : '',
    `<meta property="og:locale" content="${lang === 'de' ? 'de_DE' : 'en_US'}">`,
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`,
  ]
    .filter(Boolean)
    .join('\n');

  let buy: string;
  if (ctx.mode === 'live' && ctx.buyUrl) buy = `<a class="buy" href="${escapeHtml(ctx.buyUrl)}" rel="nofollow">${t.buy} – ${escapeHtml(price)}</a>`;
  else if (ctx.mode === 'discontinued') buy = `<p><strong>${t.discontinued}</strong></p>`;
  else if (ctx.mode === 'coming-soon' || (ctx.mode === 'live' && !ctx.buyUrl)) buy = `<span class="buy disabled" aria-disabled="true">${t.soon}</span>`;
  else buy = `<span class="buy disabled" data-buy="placeholder" aria-disabled="true">${t.preview}</span>`;

  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
  const faq = copy.faq.map((f) => `<h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p>`).join('\n');
  const body = `<header>
<p class="note"><a href="../">${t.catalog}</a></p>
<h1>${escapeHtml(copy.headline)}</h1>
<p class="sub">${escapeHtml(copy.subheadline)}</p>
</header>
<main>
<div class="card">
<div class="price">${escapeHtml(price)}</div>
<p class="note">${escapeHtml(ctx.priceNote)}</p>
${buy}
</div>
<h2>${t.benefits}</h2>
${list(copy.benefits)}
<h2>${t.outline}</h2>
${list(copy.outline)}
<h2>${t.faq}</h2>
${faq}
<div class="card note">
<p>${t.ai}</p>
<p>${WITHDRAWAL_NOTICE_DE}${lang === 'en' ? ` ${WITHDRAWAL_NOTICE_EN}` : ''}</p>
</div>
</main>
${footer(lang, ctx.operator, '../')}`;
  return page({ lang, title: `${v.title}`, head, body, noindex: ctx.mode === 'preview' || ctx.mode === 'discontinued' });
}

export function footer(lang: 'de' | 'en', operator: Operator | undefined, rel: string): string {
  const t = T[lang];
  return `<footer>
<p>${operator ? `© ${escapeHtml(operator.name)} · ` : ''}<a href="${rel}impressum.html">${t.imprint}</a> · <a href="${rel}datenschutz.html">${t.privacy}</a></p>
</footer>`;
}

/** Download page for a digital product (Markdown rendered to HTML). */
export function renderProductPage(v: Pick<Venture, 'title' | 'idea'>, bodyHtml: string, operator?: Operator, rel = '../../'): string {
  const lang = v.idea.language;
  const body = `<header><h1>${escapeHtml(v.title)}</h1><p class="note">${T[lang].ai}</p></header>
<main>
${bodyHtml}
</main>
${footer(lang, operator, rel)}`;
  return page({ lang, title: v.title, body, noindex: true });
}

export function renderImpressum(op: Operator): string {
  const body = `<header><h1>Impressum</h1></header>
<main>
<p>Angaben gemäß § 5 DDG (Digitale-Dienste-Gesetz)</p>
<p>${escapeHtml(op.name)}<br>${escapeHtml(op.address).replace(/\n|, ?/g, '<br>')}</p>
<p>E-Mail: <a href="mailto:${escapeHtml(op.email)}">${escapeHtml(op.email)}</a></p>
<p>Verantwortlich für den Inhalt: ${escapeHtml(op.name)}</p>
<p class="note">Die Produkte auf dieser Website wurden KI-gestützt erstellt und vor der Veröffentlichung vom Betreiber freigegeben.
Wir sind nicht verpflichtet und nicht bereit, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>
</main>
${footer('de', op, '')}`;
  return page({ lang: 'de', title: 'Impressum', body });
}

export function renderDatenschutz(op: Operator, paymentProvider: 'stripe' | 'none'): string {
  const stripe =
    paymentProvider === 'stripe'
      ? `<h2>Zahlungsabwicklung</h2><p>Käufe werden über Stripe (Stripe Payments Europe, Ltd., Dublin, Irland) abgewickelt. Beim Klick auf „Kaufen“ wirst du zu Stripe weitergeleitet; dort gelten die Datenschutzhinweise von Stripe. Wir erhalten von Stripe die für die Abwicklung nötigen Daten (z. B. Name, E-Mail, Betrag). Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.</p>`
      : '';
  const body = `<header><h1>Datenschutzerklärung</h1></header>
<main>
<h2>Verantwortlicher</h2>
<p>${escapeHtml(op.name)}, ${escapeHtml(op.address)}, E-Mail: ${escapeHtml(op.email)}</p>
<h2>Hosting und Server-Logs</h2>
<p>Diese Website besteht aus statischen Dateien. Der Hosting-Anbieter kann technisch notwendige Zugriffsdaten (IP-Adresse, Zeitpunkt, abgerufene Datei, User-Agent) in Server-Logs verarbeiten. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (sicherer Betrieb).</p>
<h2>Cookies, Tracking, Analyse</h2>
<p>Diese Website setzt keine Cookies und verwendet keine Analyse- oder Tracking-Werkzeuge. Es werden keine externen Schriftarten oder Skripte geladen.</p>
${stripe}
<h2>Deine Rechte</h2>
<p>Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch sowie das Recht auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde. Kontakt: ${escapeHtml(op.email)}.</p>
<p class="note">Automatisch erzeugte Vorlage – der Betreiber ist für die Richtigkeit verantwortlich und sollte sie prüfen lassen.</p>
</main>
${footer('de', op, '')}`;
  return page({ lang: 'de', title: 'Datenschutzerklärung', body });
}

export function renderCatalog(items: Array<{ title: string; slug: string; description: string; price: string }>, operator?: Operator, siteUrl?: string): string {
  const cards = items.length
    ? items.map((i) => `<div class="card"><h2><a href="${escapeHtml(i.slug)}/">${escapeHtml(i.title)}</a></h2><p>${escapeHtml(i.description)}</p><p class="price">${escapeHtml(i.price)}</p></div>`).join('\n')
    : '<p>Derzeit keine Produkte. / No products yet.</p>';
  const head = siteUrl ? `<link rel="canonical" href="${escapeHtml(siteUrl)}/">\n<meta name="description" content="Digitale Produkte und Werkzeuge / digital products and tools">` : '';
  const body = `<header><h1>Produkte / Products</h1><p class="note">${T.de.ai}</p></header>
<main>
${cards}
</main>
${footer('de', operator, '')}`;
  return page({ lang: 'de', title: 'Produkte', head, body });
}

export function renderSitemap(siteUrl: string, slugs: string[], lastmod: string): string {
  const urls = [`${siteUrl}/`, ...slugs.map((s) => `${siteUrl}/${s}/`), `${siteUrl}/impressum.html`, `${siteUrl}/datenschutz.html`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeHtml(u)}</loc><lastmod>${lastmod.slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>
`;
}

export function renderRobots(siteUrl: string): string {
  return `User-agent: *
Allow: /

Sitemap: ${siteUrl}/sitemap.xml
`;
}
