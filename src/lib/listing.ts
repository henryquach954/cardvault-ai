/**
 * Listing generation.
 *
 * This is a DETERMINISTIC generator, not an AI one. It assembles titles and
 * descriptions from facts already saved against the card: catalog identity,
 * condition, defects, grade. That is a feature, not a limitation — it means
 * the output cannot contain a set, rarity, grade or claim that is not in
 * your own records.
 *
 * Rules it will not break, from the brief:
 *   - never invent the set, rarity, condition, authenticity, grade, or what
 *     is included
 *   - never describe an item as "tested", "authenticated" or "verified"
 *     unless the operator has confirmed it
 *   - every generated field stays editable
 *
 * An AI pass could later rewrite these for engagement. It would be an
 * enhancement layered on top, and it would still be fed only these facts.
 */

import type { InventoryItemFull } from './store/types';
import { CONDITIONS } from '../providers/types';
import { formatMoney } from './money';

export type Marketplace = 'ebay' | 'facebook' | 'mercari';

export interface MarketplaceSpec {
  id: Marketplace;
  label: string;
  /** Maximum title length the app will produce. */
  titleLimit: number;
  descriptionLimit: number;
  /** True when a real publishing API exists for individual sellers. */
  canPublish: boolean;
  /** Where to go to post it by hand. */
  manualUrl: string;
  note: string;
}

/**
 * Title limits are the app's own conservative settings, not verified
 * platform contracts — eBay's 80 characters is long-standing and well
 * documented, the others are safe defaults. Staying under a limit never
 * hurts; exceeding one gets a listing rejected.
 */
export const MARKETPLACES: MarketplaceSpec[] = [
  {
    id: 'ebay',
    label: 'eBay',
    titleLimit: 80,
    descriptionLimit: 4000,
    canPublish: false, // true only once seller credentials are configured
    manualUrl: 'https://www.ebay.com/sl/sell',
    note:
      'eBay has a real seller API, but it needs a developer account, production keys, '
      + 'business policies and an inventory location before anything can be published. '
      + 'Until that is configured this is a manual handoff like the others.',
  },
  {
    id: 'facebook',
    label: 'Facebook Marketplace',
    titleLimit: 100,
    descriptionLimit: 5000,
    canPublish: false,
    manualUrl: 'https://www.facebook.com/marketplace/create/item',
    note:
      'Facebook Marketplace has no public listing API for individual sellers. '
      + 'Verified, not assumed. Copy and paste is the only route.',
  },
  {
    id: 'mercari',
    label: 'Mercari',
    titleLimit: 80,
    descriptionLimit: 1000,
    canPublish: false,
    manualUrl: 'https://www.mercari.com/sell/',
    note:
      'Mercari has no public seller API. Integration is restricted to approved '
      + 'partners. Copy and paste is the only route.',
  },
];

export function marketplaceSpec(id: Marketplace): MarketplaceSpec {
  return MARKETPLACES.find((m) => m.id === id)!;
}

export interface GeneratedListing {
  marketplace: Marketplace;
  title: string;
  description: string;
  keywords: string[];
  category: string;
  conditionText: string;
  shippingNotes: string;
  /** Flagged when the title had to be shortened to fit. */
  titleTruncated: boolean;
}

/** Which template applies, based on what the item actually is. */
export type TemplateKind =
  | 'graded_slab' | 'high_value_single' | 'raw_single'
  | 'sealed_product' | 'bulk_group';

const HIGH_VALUE_CENTS = 10_000; // $100

export function templateFor(item: InventoryItemFull): TemplateKind {
  if (item.kind === 'graded_slab') return 'graded_slab';
  if (item.kind === 'sealed_product') return 'sealed_product';
  if (item.kind === 'bulk_group') return 'bulk_group';
  const value = item.market_value_override_cents ?? item.market_value_cents ?? 0;
  return value >= HIGH_VALUE_CENTS ? 'high_value_single' : 'raw_single';
}

export const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  graded_slab: 'Graded slab',
  high_value_single: 'High-value single',
  raw_single: 'Raw single',
  sealed_product: 'Sealed product',
  bulk_group: 'Bulk group',
};

/** Trim to a limit on a word boundary rather than mid-word. */
function fit(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return {
    text: (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim(),
    truncated: true,
  };
}

const GAME_LABELS: Record<string, string> = {
  pokemon: 'Pokemon',
  mtg: 'MTG',
  yugioh: 'Yu-Gi-Oh',
  onepiece: 'One Piece',
  lorcana: 'Lorcana',
  digimon: 'Digimon',
  sports: 'Sports',
  other: '',
};

/**
 * Title parts in priority order. The first elements survive truncation, so
 * they are the ones a buyer searches for: game, name, set, number.
 */
function titleParts(item: InventoryItemFull): string[] {
  const c = item.card_catalog;
  const parts: string[] = [];

  const game = c?.game ? GAME_LABELS[c.game] : '';
  if (game) parts.push(game);
  parts.push(c?.name ?? 'Trading card');

  if (c?.set_name) parts.push(c.set_name);
  if (c?.collector_number) {
    parts.push(`#${c.collector_number}`);
  }
  if (item.kind === 'graded_slab' && item.grading_company && item.grade != null) {
    parts.push(`${item.grading_company} ${item.grade}`);
  }
  if (c?.finish && c.finish !== 'Normal') parts.push(c.finish);
  if (c?.rarity) parts.push(c.rarity);
  if (c?.edition) parts.push(c.edition);
  if (c?.language && c.language !== 'en') parts.push(c.language.toUpperCase());
  if (item.kind !== 'graded_slab') {
    parts.push(CONDITIONS.find((x) => x.value === item.condition)?.label ?? '');
  }
  return parts.filter(Boolean);
}

/** The honest condition paragraph, built from recorded facts only. */
function conditionText(item: InventoryItemFull): string {
  if (item.kind === 'graded_slab') {
    const base =
      `Professionally graded ${item.grading_company} ${item.grade}.`
      + (item.cert_number ? ` Certification number ${item.cert_number}.` : '');
    // Only claim verification if the operator actually ticked it.
    return item.grade_verified
      ? `${base} Certification confirmed against the grader's database.`
      : `${base} Please verify the certification number yourself before purchase.`;
  }

  const label = CONDITIONS.find((x) => x.value === item.condition)?.label ?? 'Unspecified';
  const defects = Object.entries(item.defects ?? {})
    .filter(([, on]) => on)
    .map(([k]) => k.replace(/_/g, ' '));

  const lines = [`Condition: ${label}.`];
  if (item.condition === 'NEEDS_REVIEW') {
    lines[0] = 'Condition has not been graded yet — please ask before buying.';
  }
  if (defects.length > 0) {
    lines.push(`Visible wear: ${defects.join(', ')}.`);
  }
  if (item.condition_notes) lines.push(item.condition_notes);
  lines.push('Photographs show the exact card you will receive.');
  return lines.join(' ');
}

function keywordsFor(item: InventoryItemFull): string[] {
  const c = item.card_catalog;
  const words = new Set<string>();
  const add = (v?: string | null) => { if (v) words.add(v.toLowerCase()); };

  add(c?.game ? GAME_LABELS[c.game] : null);
  add(c?.name);
  add(c?.set_name);
  add(c?.set_code);
  add(c?.rarity);
  add(c?.finish);
  add(c?.edition);
  if (c?.collector_number) add(`${c.collector_number}`);
  if (item.kind === 'graded_slab') {
    add(item.grading_company);
    add(`${item.grading_company} ${item.grade}`);
    add('graded');
    add('slab');
  } else {
    add(CONDITIONS.find((x) => x.value === item.condition)?.label);
  }
  add('tcg');
  add('trading card');
  return [...words].filter(Boolean);
}

function categoryFor(item: InventoryItemFull): string {
  const game = item.card_catalog?.game;
  if (item.kind === 'sealed_product') return 'Sealed product';
  if (game === 'sports') return 'Sports trading cards';
  if (item.kind === 'graded_slab') return 'Graded trading cards';
  return 'Collectible card games — single cards';
}

function shippingFor(item: InventoryItemFull, marketplace: Marketplace): string {
  const value = item.market_value_override_cents ?? item.market_value_cents ?? 0;
  const tracked = value >= 2_000;
  const base = item.kind === 'graded_slab'
    ? 'Slab shipped in a bubble mailer with corner protection.'
    : 'Card shipped in a penny sleeve and top loader, inside a rigid mailer.';

  const service = tracked
    ? 'Tracked postage, as this is a higher-value card.'
    : 'Standard postage. Tracking available on request.';

  const local = marketplace === 'facebook'
    ? ' Local collection welcome.'
    : '';

  return `${base} ${service}${local}`;
}

/**
 * Build a listing for one marketplace.
 *
 * Every string here derives from a stored field. Nothing is inferred, and
 * nothing claims testing, authentication or provenance the operator has not
 * recorded.
 */
export function generateListing(
  item: InventoryItemFull,
  marketplace: Marketplace
): GeneratedListing {
  const spec = marketplaceSpec(marketplace);
  const template = templateFor(item);
  const c = item.card_catalog;

  const { text: title, truncated } = fit(titleParts(item).join(' '), spec.titleLimit);

  // --- Description -------------------------------------------------------
  const facts: string[] = [];
  if (c?.name) facts.push(`Card: ${c.name}`);
  if (c?.set_name) facts.push(`Set: ${c.set_name}${c.set_code ? ` (${c.set_code})` : ''}`);
  if (c?.collector_number) facts.push(`Number: ${c.collector_number}`);
  if (c?.rarity) facts.push(`Rarity: ${c.rarity}`);
  if (c?.finish) facts.push(`Finish: ${c.finish}`);
  if (c?.edition) facts.push(`Edition: ${c.edition}`);
  if (c?.language) facts.push(`Language: ${c.language.toUpperCase()}`);
  if (item.kind === 'graded_slab') {
    facts.push(`Grade: ${item.grading_company} ${item.grade}`);
    if (item.cert_number) facts.push(`Certification: ${item.cert_number}`);
  }
  if (item.quantity_available > 1) {
    facts.push(`Available: ${item.quantity_available}`);
  }

  const opening: Record<TemplateKind, string> = {
    graded_slab:
      `${c?.name ?? 'Graded card'} in a ${item.grading_company} ${item.grade} slab.`,
    high_value_single:
      `${c?.name ?? 'Card'}${c?.set_name ? ` from ${c.set_name}` : ''}. `
      + `Carefully stored and shipped with protection appropriate to its value.`,
    raw_single:
      `${c?.name ?? 'Card'}${c?.set_name ? ` from ${c.set_name}` : ''}.`,
    sealed_product:
      `${c?.name ?? 'Sealed product'}. Sold as pictured, unopened.`,
    bulk_group:
      `${c?.name ?? 'Bulk card lot'}. `
      + `${item.quantity} cards included, as described below.`,
  };

  const descriptionParts = [
    opening[template],
    '',
    facts.join('\n'),
    '',
    conditionText(item),
    '',
    shippingFor(item, marketplace),
  ];

  if (marketplace === 'mercari') {
    // Mercari descriptions are short; drop the blank-line padding.
    descriptionParts.splice(1, 1);
    descriptionParts.splice(2, 1);
  }

  const { text: description } = fit(
    descriptionParts.join('\n').trim(),
    spec.descriptionLimit
  );

  return {
    marketplace,
    title,
    description,
    keywords: keywordsFor(item),
    category: categoryFor(item),
    conditionText: conditionText(item),
    shippingNotes: shippingFor(item, marketplace),
    titleTruncated: truncated,
  };
}

/** A plain-text block ready to paste into a marketplace's own form. */
export function asPasteBlock(
  listing: GeneratedListing,
  priceCents: number | null,
  currency: string
): string {
  return [
    `TITLE`,
    listing.title,
    '',
    `PRICE`,
    priceCents != null ? formatMoney(priceCents, currency as 'USD') : '(not set)',
    '',
    `CATEGORY`,
    listing.category,
    '',
    `DESCRIPTION`,
    listing.description,
    '',
    `KEYWORDS`,
    listing.keywords.join(', '),
  ].join('\n');
}
