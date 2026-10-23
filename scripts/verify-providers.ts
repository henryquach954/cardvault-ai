/**
 * Live provider verification.
 *
 * Hits the real third-party APIs. This is an integration check, not a unit
 * test: the whole point is to prove the adapters work against the services as
 * they actually behave today, rather than against a mock of what the docs say.
 *
 * It will fail if a provider changes its contract or goes down, which is
 * exactly the signal we want.
 *
 * Run: npm run verify:providers
 */
import { tcgdex } from '../src/providers/catalog/tcgdex';
import { scryfall } from '../src/providers/catalog/scryfall';
import { ygoprodeck } from '../src/providers/catalog/ygoprodeck';
import { UNAVAILABLE_PROVIDERS, activePricingProvidersFor } from '../src/providers/registry';
import { formatMoney } from '../src/lib/money';
import { CLAIM_LABELS, COMP_ELIGIBLE } from '../src/providers/types';
import type { CardCandidate } from '../src/providers/types';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

function show(c: CardCandidate): string {
  const bits = [
    c.name,
    c.setName ? `(${c.setName})` : c.setCode ? `(${c.setCode})` : '',
    c.collectorNumber ? `#${c.collectorNumber}${c.setTotal ? `/${c.setTotal}` : ''}` : '',
    c.rarity ?? '',
    c.finish ?? '',
  ].filter(Boolean);
  return bits.join(' · ');
}

async function main() {
  console.log('\n=== TCGdex (Pokémon) ===');
  {
    const results = await tcgdex.search({ game: 'pokemon', name: 'Charizard ex', limit: 8 });
    check('search returns candidates', results.length > 0, `got ${results.length}`);
    check('candidates carry a set name', results.some((r) => !!r.setName));
    check('candidates carry a collector number', results.every((r) => !!r.collectorNumber));
    check(
      'search does NOT invent rarity or finish',
      results.every((r) => r.rarity === undefined && r.finish === undefined),
      'search results must stay sparse; those fields need the detail call'
    );
    for (const r of results.slice(0, 4)) console.log(`       ${show(r)}`);

    const printings = await tcgdex.listPrintings('sv03.5-199');
    check('listPrintings expands finishes', printings.length >= 1, `got ${printings.length}`);
    check('each printing names its finish', printings.every((p) => !!p.finish));
    check('printings carry rarity from the detail call', printings.every((p) => !!p.rarity));
    for (const p of printings) console.log(`       ${show(p)}`);

    const jp = await tcgdex.search({ game: 'pokemon', name: 'リザードン', language: 'ja', limit: 3 });
    check('Japanese search works', jp.length > 0, `got ${jp.length}`);
    if (jp[0]) console.log(`       ${show(jp[0])}`);

    const byNumber = await tcgdex.search({
      game: 'pokemon', name: 'Charizard', collectorNumber: '4', setCode: 'base1',
    });
    check('narrowing by set + collector number works', byNumber.length > 0, `got ${byNumber.length}`);
    if (byNumber[0]) console.log(`       ${show(byNumber[0])}`);

    const missing = await tcgdex.getById('definitely-not-a-card-xyz');
    check('unknown id returns null rather than throwing', missing === null);
  }

  console.log('\n=== TCGdex pricing ===');
  {
    const res = await tcgdex.fetchPrices({
      game: 'pokemon',
      externalId: 'sv03.5-199',
      name: 'Charizard ex',
      finish: 'Holofoil',
    });
    check('pricing returns ok', res.status === 'ok', res.message ?? '');
    check('at least one claim returned', res.claims.length > 0);

    const kinds = new Set(res.claims.map((c) => c.claimType));
    check('claims are typed by what they actually are', kinds.size > 1,
      `types present: ${[...kinds].join(', ')}`);
    check(
      'no claim is mislabelled as an individual completed sale',
      !res.claims.some((c) => c.claimType === 'sold_observation'),
      'TCGdex has no per-transaction data, so it must never emit sold_observation'
    );
    check(
      'every claim declares its condition as unknown',
      res.claims.every((c) => c.condition == null),
      'TCGdex pricing is not condition-specific and must not pretend otherwise'
    );
    check('every claim carries a retrieval timestamp', res.claims.every((c) => !!c.retrievedAt));
    check('every claim explains itself', res.claims.every((c) => !!c.notes));

    for (const c of res.claims.slice(0, 6)) {
      console.log(
        `       ${formatMoney(c.priceCents, c.currency as 'USD')} ` +
        `[${CLAIM_LABELS[c.claimType]}] ${c.provider}`
      );
    }

    const mismatch = await tcgdex.fetchPrices({
      game: 'pokemon', externalId: 'sv03.5-199', name: 'Charizard ex', finish: 'Reverse Holofoil',
    });
    check(
      'a finish that does not exist yields not_found, not a wrong price',
      mismatch.status === 'not_found' || mismatch.claims.every((c) => c.finish !== 'Holofoil'),
      `status=${mismatch.status}`
    );
  }

  console.log('\n=== Scryfall (MTG) ===');
  {
    const results = await scryfall.search({ game: 'mtg', name: 'Black Lotus', limit: 5 });
    check('search returns printings', results.length > 0, `got ${results.length}`);
    check('printings carry set + collector number',
      results.every((r) => !!r.setCode && !!r.collectorNumber));
    for (const r of results.slice(0, 3)) console.log(`       ${show(r)}`);

    const none = await scryfall.search({ game: 'mtg', name: 'zzzz not a real card zzzz' });
    check('no-match returns an empty list rather than throwing', Array.isArray(none) && none.length === 0);

    if (results[0]) {
      const prices = await scryfall.fetchPrices({
        game: 'mtg', externalId: results[0].externalId, name: results[0].name,
      });
      check('pricing responds', prices.status === 'ok' || prices.status === 'not_found',
        `status=${prices.status} ${prices.message ?? ''}`);
      check('scryfall never emits a completed-sale claim',
        !prices.claims.some((c) => c.claimType === 'sold_observation'));
      for (const c of prices.claims.slice(0, 3)) {
        console.log(`       ${formatMoney(c.priceCents, c.currency as 'USD')} ` +
          `[${CLAIM_LABELS[c.claimType]}] ${c.finish ?? ''}`);
      }
    }
  }

  console.log('\n=== YGOPRODeck (Yu-Gi-Oh!) ===');
  {
    const results = await ygoprodeck.search({ game: 'yugioh', name: 'Dark Magician', limit: 6 });
    check('search returns printings', results.length > 0, `got ${results.length}`);
    check('printings carry a rarity', results.some((r) => !!r.rarity));
    for (const r of results.slice(0, 4)) console.log(`       ${show(r)}`);

    const none = await ygoprodeck.search({ game: 'yugioh', name: 'zzzznotarealcardzzzz' });
    check('no-match returns empty rather than throwing', none.length === 0);

    if (results[0]) {
      const prices = await ygoprodeck.fetchPrices({
        game: 'yugioh', externalId: results[0].externalId, name: results[0].name,
      });
      check('pricing responds', prices.status === 'ok', prices.message ?? '');
      check('the per-card caveat is attached to every claim',
        prices.claims.every((c) => (c.notes ?? '').includes('not per printing')));
      for (const c of prices.claims.slice(0, 3)) {
        console.log(`       ${formatMoney(c.priceCents, c.currency as 'USD')} ` +
          `[${CLAIM_LABELS[c.claimType]}] ${c.provider}`);
      }
    }
  }

  console.log('\n=== Unavailable providers behave honestly ===');
  {
    for (const p of UNAVAILABLE_PROVIDERS) {
      const res = await p.fetchPrices({ game: 'pokemon', name: 'Charizard' });
      const good =
        p.isConfigured() === false &&
        res.status === 'unconfigured' &&
        res.claims.length === 0 &&
        !!res.message;
      check(`${p.label} reports unconfigured and returns no prices`, good);
    }
    const active = activePricingProvidersFor('pokemon').map((p) => p.id);
    check('only genuinely usable providers are active for Pokémon',
      active.length === 1 && active[0] === 'tcgdex', `active: ${active.join(', ') || 'none'}`);
  }

  console.log('\n=== Comp eligibility rule ===');
  {
    const res = await tcgdex.fetchPrices({
      game: 'pokemon', externalId: 'sv03.5-199', name: 'Charizard ex', finish: 'Holofoil',
    });
    const eligible = res.claims.filter((c) => COMP_ELIGIBLE.has(c.claimType));
    check(
      'no free-tier claim is eligible to be averaged into a sold comp',
      eligible.length === 0,
      `${eligible.length} claims wrongly eligible`
    );
    console.log('       (correct: free sources give estimates, so comps require manual entry)');
  }

  console.log(`\n${'-'.repeat(58)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m${passed} checks passed, 0 failed.\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m${passed} passed, ${failures.length} FAILED:\x1b[0m`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log();
  process.exit(1);
}

main().catch((e) => {
  console.error('\nHarness crashed:', e);
  process.exit(1);
});
