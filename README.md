# CardVault AI

A private trading-card inventory, pricing and listing tool. Pokémon first, with
Magic, Yu-Gi-Oh!, One Piece, sports and other cards supported by the same data
model.

**All ten sections are built.** No integration is simulated anywhere in this
codebase, and nothing claims a capability it does not have.

| Stage | What | Status |
| --- | --- | --- |
| 1 | Core inventory, photos, catalog identification | **Done** |
| 2 | Pricing, comps, condition adjustments, lookup, batch refresh | **Done** |
| 3 | Listing generation | **Done** (deterministic; AI rewrite not built) |
| 4 | Cross-posting | **Done** as copy-and-paste handoff; API publishing blocked |
| 5 | Sales, profit, duplicate-sale prevention | **Done** |
| 6 | Bulk & lots, Card Show Mode | **Done** |

Two things remain genuinely out of reach, both for the same reason — they
need credentials or access that does not exist yet:

- **eBay API publishing.** Needs a developer account, production keys,
  business policies and an inventory location. Everything up to the moment of
  posting is built.
- **AI-written listing copy and photo identification.** Need an Anthropic API
  key. The deterministic generator works without one.

---

## Getting it running

```bash
npm install
npm run dev
```

That's it. No account, no credentials. The app runs in **local mode**, storing
your inventory and photographs in this browser using IndexedDB.

### Two storage modes

| | Local (default) | Supabase |
| --- | --- | --- |
| Setup | none | free project, ~10 min |
| Devices | this browser only | any device you sign in on |
| Login | none | email + password |
| Photos | capped by the browser | effectively uncapped |
| If you clear site data | **everything is gone** | unaffected |
| Backup | manual export | managed by Supabase |

The app tells you which mode it is in: a **"On this device"** badge in the
header, and a panel at the top of **Settings**.

Local mode is a real mode, not a demo — the same invariants are enforced, and
a 70-check harness proves it against the same rules Postgres enforces. But it has exactly one copy of your data.
**Export a backup from Settings regularly.**

### Using it on your iPhone

Local mode is per-browser, so your phone would have its own separate
inventory. If you want one inventory across both devices, connect Supabase
below. Then:

```bash
npm run dev -- --host
```

Open the printed network address on your phone (same Wi-Fi), then **Share →
Add to Home Screen**. The camera capture in the scan workflow works from there.

---

## Putting it online

The app is a static site — `npm run build` produces `dist/`, which any static
host will serve for free.

```bash
npm run build          # outputs dist/
```

**The SPA fallback is already configured** and verified:

- `public/_redirects` — Netlify, Cloudflare Pages
- `vercel.json` — Vercel, plus a few sensible security headers

Without these, every route except `/` returns 404 on a real host: `/scan`,
`/inventory/<id>` and friends are client-side routes with no file behind
them. Note that `vite preview` papers over this — it has fallback built in,
so testing there proves nothing about the deployed site.

`public/robots.txt` tells crawlers to stay out. This is a business tool, not
content.

### Deploying

Easiest route, no CLI:

1. Push the repo to GitHub.
2. Import it at [vercel.com/new](https://vercel.com/new) or
   [app.netlify.com](https://app.netlify.com/start). Both auto-detect Vite —
   build `npm run build`, output `dist`.
3. If you want Supabase, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   as environment variables in the host's dashboard, then redeploy.

Leave those variables unset and the deployed site runs in **local mode**:
every visitor gets a fully working app backed by their own browser storage.

### Sharing it with another reseller

| Setup | What they get | What you share |
| --- | --- | --- |
| Deployed, **no** Supabase vars | Working app, own data in their browser, one device, no backup | Nothing — no accounts, no shared storage |
| Deployed, **your** Supabase | Own account, own data, multi-device, backed up | Your Supabase project hosts their business data, and its free-tier limits |
| They deploy **their own** copy | Everything, fully independent | Only the code |

Row-level security means a second account cannot read your rows in any of
these, and yours cannot read theirs. There is deliberately no mechanism to
share one inventory between two accounts — every table is strictly
one-owner-per-row.

If the other person is at all serious about their own business, point them
at their own copy. Hosting someone else's costs and margins in your project
makes you responsible for data that is not yours.

---

## Connecting Supabase (optional, enables multi-device)

**Export a backup from Settings first** if you already have cards in local
mode — nothing migrates automatically.

### 1. Create the Supabase project

1. Sign up at [supabase.com/dashboard](https://supabase.com/dashboard) and create a project.
2. Pick a region near you and save the database password somewhere safe.

### 2. Apply the schema

Open the project's **SQL Editor** and run these four files, in order:

1. `supabase/migrations/0001_core_schema.sql`
2. `supabase/migrations/0002_rls_and_storage.sql`
3. `supabase/migrations/0003_condition_adjustments.sql`
4. `supabase/migrations/0004_sales_uniqueness_fix.sql`

The second file creates the private `card-photos` storage bucket and all
row-level security policies. It deliberately fails loudly if any table was left
without RLS. The third seeds your condition adjustment percentages. The fourth
corrects duplicate-sale detection so it guards unique slabs without blocking
repeat sales of fungible stock.

### 3. Point the app at it

```bash
cp .env.example .env.local
```

Fill in both values from **Project Settings → API**:

| Variable | Where to find it |
| --- | --- |
| `VITE_SUPABASE_URL` | Project URL |
| `VITE_SUPABASE_ANON_KEY` | the `anon` / `public` key |

Only the **anon** key goes here. It is safe in a browser because row-level
security, not key secrecy, protects your data. Never put the `service_role` key
in a `VITE_` variable — anything with that prefix is compiled into the
JavaScript your browser downloads.

### 4. Restart and sign in

Restart the dev server so Vite picks up `.env.local`. The app will now ask you
to create an account — the "On this device" badge disappears once you are in
Supabase mode.

If Supabase emails you a confirmation link and you would rather it did not,
turn that off under **Authentication → Providers → Email → Confirm email**.

### 5. Bring your local data across

In **Settings → Import backup**, choose the file you exported earlier. Ids are
preserved so photos stay attached; every row is re-owned by your new account.

---

## Verifying it actually works

Five harnesses, all runnable without credentials:

```bash
npm run verify            # all five — 280 checks
npm run verify:schema     # migrations + constraints, against real Postgres (PGlite/WASM)
npm run verify:local      # the IndexedDB backend, held to the same invariants
npm run verify:render     # every page renders without crashing
npm run verify:providers  # live calls to the real catalog APIs
npm run verify:valuation  # comp maths, confidence rules, money handling
```

`verify:schema` boots an in-process Postgres, applies the real migrations and
then tries to violate every safety constraint — overselling, double-selling a
slab, publishing a listing without proof, deleting price history, reading
another user's rows.

`verify:local` runs the matching set against the browser backend, because a
second storage engine that is not held to the same standard is just a slower
way to corrupt your inventory.

`verify:providers` hits TCGdex, Scryfall and YGOPRODeck for real, so it will
fail if a provider changes its contract. That is the point.

---

## Where the data comes from

Verified 22 October 2026. The app shows this same table in **Settings**, with
reasons.

### Working now, free, no account

| Source | Covers | Gives |
| --- | --- | --- |
| **TCGdex** | Pokémon, 9 languages | Catalog + Cardmarket and TCGplayer price snapshots |
| **Scryfall** | Magic: The Gathering | Catalog + daily price snapshot per finish |
| **YGOPRODeck** | Yu-Gi-Oh! | Catalog + vendor prices (per card, not per printing) |

### Not available, and why

| Source | Reason |
| --- | --- |
| **Pokémon TCG API** | Deprecated. New registrations closed; existing keys expire 1 Mar 2027. Officially redirects to Scrydex. |
| **TCGplayer** | API programme closed to new applicants. |
| **eBay sold listings** | `findCompletedItems` retired Feb 2025. Browse API returns active listings only. Marketplace Insights is limited-release and effectively closed. Sold listings went behind a sign-in wall in July 2026. |
| **Card Ladder** | No public developer API. Only third-party scrapers exist, which this app will not use. |
| **ALT** | No general public API. A cert lookup is referenced but appears partner-gated. |
| **Facebook Marketplace** | No API for individual sellers. Partner-only, EEA classifieds. Manual handoff only. |
| **Mercari** | No public seller API. Partner-only. Manual handoff only. |
| **Scrydex** | Paid, from ~$29/month, no free tier. The only verified source with condition-specific raw pricing *and* graded pricing *and* sold history. Adapter slot is ready. |

**The consequence you need to understand:** no connected source provides
individual completed sales, so **graded-slab comps must be entered by hand**.
Open any item → *Add a comp manually*. Those entries are real dated sales and
feed the averaging exactly as an API source would.

---

## How the pricing engine stays honest

Every price carries a **claim type**, and the distinction is enforced by the
database and the type system, not by convention:

| Claim type | Meaning |
| --- | --- |
| `sold_observation` | One real transaction, with a date. **Only these can form a comp.** |
| `sold_aggregate` | A provider's own average of real sales (e.g. Cardmarket `avg7`). |
| `market_estimate` | A provider's derived market price. Not a transaction. |
| `asking_price` | What someone wants today. No evidence anyone paid it. |
| `ai_estimate` | Model output. Never authoritative. |
| `manual` | You typed it. |

Consequences that follow automatically:

- An asking price **cannot** be averaged into a comp — `computeComp` only
  accepts `sold_observation`, so the wrong input cannot physically reach it.
- A `sold_observation` without a date is rejected by a database CHECK.
- Price history is **append-only**: there is no UPDATE or DELETE policy on
  `price_observations`, so changing your override cannot erase the underlying
  sales.
- A PSA 9 sale is never averaged into a PSA 10 comp, and the exclusion is shown
  with its reason.
- Currencies are never silently converted.
- A Near-Mint-anchored price shown against a played card is adjusted only by
  **your** percentages, and labelled as such (see below).

### Condition adjustments

No connected source gives condition-specific pricing — every raw price arrives
anchored to Near Mint. Rather than show an NM price against a played card, or
invent a discount, the app applies your own percentages:

| Condition | % of Near Mint |
| --- | --- |
| NM | 100 (the anchor, never adjusted) |
| LP | 85 |
| MP | 70 |
| HP | 50 |
| DMG | 30 |

Editable in **Settings**, and switchable off entirely. When applied, the result:

- is labelled **"Derived estimate, not market data"**
- shows its arithmetic (`$324.63 NM × 70% = $227.24 · your MP setting`)
- is **capped at low confidence**, because it is indirect pricing evidence
- is **never** applied to a graded slab, to a card whose condition is still
  unassessed, or to a price a provider actually reported *for that condition*

If a condition has no percentage set, the app warns rather than interpolating
between the ones that do. The database rejects values outside 1–100, which
catches the realistic typo of entering `0.85` instead of `85` — that would
otherwise price a $300 card at under three cents.

---

## Price Research — looking up a card you do not own

**Price Research** in the sidebar searches the catalog for any card and prices
it immediately. Built for the moment someone offers you a card at a show and
you need to know what it is worth before handing over cash.

- Pick the exact printing, then the condition you are considering — your
  condition adjustment applies live, with the arithmetic shown.
- Every figure returned is listed with **what it actually is**: average of
  completed sales, market estimate, or current asking price.
- Switching to **Graded slab** does not invent a slab price. It says plainly
  that no connected source prices graded cards and that the figures shown are
  raw-card prices.
- If you already own the card, it shows how many, what you paid, and where it
  is stored — so you do not buy a second copy by accident.
- **Add to inventory** carries the confirmed printing straight into the scan
  workflow.

A lookup is **read-only**: it writes no catalog row, no price observation, no
inventory. Checking a price on a card you decide not to buy leaves no residue
in your records.

---

## Listings and cross-posting

**Create Listings** generates marketplace copy from a card you have already
saved. The generator is **deterministic, not AI** — every word comes from a
fact in your own records, which is precisely why it cannot invent a set,
rarity, grade or authenticity claim. Five templates: raw single, high-value
single, graded slab, sealed product, bulk group.

It will not write "tested", "authenticated" or "verified" unless you ticked
the box yourself. An unverified slab says *"please verify the certification
number yourself"*. An ungraded condition says so rather than guessing. Every
field stays editable, and titles are capped per marketplace with a live
character count.

**Cross-Posting** is the handoff. Verified 22 October 2026:

| Marketplace | Automated posting | Why |
| --- | --- | --- |
| eBay | No (yet) | Real API exists, needs developer account, production keys, business policies, inventory location |
| Facebook Marketplace | No | No public listing API for individual sellers |
| Mercari | No | No public seller API; approved partners only |

So the page does the thing that actually works: copy-ready text, a link to
the right form, and status tracking. **Mark as posted** requires you to paste
the real listing URL — the database rejects a Published status without one,
so the app can never report a listing as live on nothing but a button press.

---

## Bulk & Lots

A lot bundles specific cards to sell as one unit. The dangerous part is
allocation, and it is handled by the same quantity ledger as everything else:

- Adding a card to a lot increments `quantity_allocated`, so its
  `quantity_available` drops.
- A card with nothing available **cannot** be added to a second lot, sold
  individually, or sold at a card show. Tested in both backends.
- Removing a card, or deleting the lot, **releases** the stock rather than
  stranding it.
- Selling the lot moves every allocated card to sold in one transaction, with
  the lot's combined cost as the basis.

Bulk *groups* — a shoebox of commons priced as a unit — are a different
thing, and live in inventory as kind `bulk_group`. Create those from Scan.

---

## Card Show Mode

A deliberately different screen from Inventory: one always-focused search
box, large tap targets, and the three numbers you need while someone waits —
asking price, what you paid, where it is stored. Two taps to record a cash
sale, with today's takings and profit across the top.

Only stock with availability appears. Cards already sold or allocated to a
lot are hidden, so you cannot sell something twice at a table.

---

## Sales and profit

Every figure on the Sales & Profit page comes from recorded transactions.
Estimated market value never enters them — "what I think it is worth" and
"what someone actually paid" are different questions.

```
Gross revenue        sale price + shipping the buyer paid
− Cost of cards      snapshot at the moment of sale
− Fees               marketplace, postage, packaging, other, refunds
= Trading profit
− Business expenses  sleeves, mailers, table fees, travel
= Net after expenses
```

**Cost is snapshot at sale time.** Editing a card's purchase cost later cannot
retroactively rewrite historical profit.

**Unknown cost is not treated as zero.** A card with no recorded purchase cost
produces a profit figure explicitly flagged as optimistic, because silently
assuming zero would overstate every margin in the business.

### Duplicate-sale prevention

Two different mechanisms, because two different things can go wrong:

- **A unique object sold twice** — a graded slab can appear in exactly one sale,
  enforced by a partial unique index and a database trigger that decides what
  counts as unique. Raw singles are deliberately exempt: they are governed by
  the quantity ledger instead.
- **Overselling fungible stock** — `quantity_available` is a generated column
  with `CHECK >= 0`, so selling four copies of a three-copy card is impossible.

A third case is **flagged, not refused**: when two sales of the same card land
within ten minutes, the second is marked `needs_review` with a reason. Selling
two copies on the same day is perfectly normal, so refusing it would be worse
than surfacing it.

Voiding a sale returns the stock and **appends a reversal** to the movement
ledger rather than deleting the original entry.

### What cannot be automated

When a card sells, other marketplace listings are **not** ended automatically,
and the app says so on every sale. No publishing integration exists (see Stage
4 in the provider table), so claiming otherwise would be a lie with real
money attached.

---

### Five values, kept separate

1. Raw provider observations (append-only history)
2. The calculated comp or estimate
3. Your manual market-value override
4. Your asking price
5. Your minimum acceptable price

Refreshing (1) never touches (3), (4) or (5).

---

## Safety built into the schema

These are enforced by the database, and each has a test:

- `quantity_available` is a **generated column** (`quantity − sold − allocated`)
  with a `CHECK ≥ 0`, so overselling and double-allocation are impossible.
- A graded slab must have a grading company and grade; a raw single must not.
- A slab's quantity is pinned to 1 — a unique object is not a stack.
- The same certification number cannot be entered twice.
- A unique item cannot be sold twice, even across two marketplaces.
- A listing cannot be marked **Published** without a real external listing id
  and timestamp from the platform.
- Money is always integer cents plus a currency code. Never floats.

---

## Project layout

```
supabase/migrations/   SQL schema, RLS policies, storage bucket
scripts/               the four verification harnesses
src/providers/         catalog + pricing adapters, and the registry
  types.ts             the claim-type model everything else depends on
  registry.ts          every provider, including honest "unavailable" ones
src/lib/
  db.ts                facade — picks a backend and delegates
  store/
    types.ts           the DataStore contract both backends implement
    rules.ts           invariants shared by both backends
    local.ts           IndexedDB backend
    supabase.ts        hosted Postgres backend
    idb.ts             small promise wrapper over IndexedDB
  valuation.ts         comp averaging, confidence, estimate summarising
  money.ts             integer-cents money handling
src/pages/             Dashboard, Scan, Inventory, ItemDetail, Settings
```

### Adding a storage backend

Implement `DataStore` from `src/lib/store/types.ts` and select it in
`src/lib/db.ts`. Run every invariant in `src/lib/store/rules.ts` — those
mirror the Postgres constraints, and a backend that skips them is a backend
that will silently corrupt the ledger.

## Adding a provider

Implement `CatalogProvider` and/or `PricingProvider` from
`src/providers/types.ts`, then add it to `src/providers/registry.ts`. The rules
that matter:

- `isConfigured()` must return `false` until credentials genuinely exist.
- Declare `capabilities` truthfully — `conditionSpecific`, `gradedPricing` and
  `individualSales` drive what the UI is willing to claim.
- Emit `sold_observation` **only** for an actual completed transaction with a
  date. If you are unsure, it is a `market_estimate`.
- Never return a near-match. If the requested finish, grade or condition is not
  available, return `not_found` with an explanation. A fallback price is
  indistinguishable from a fabricated one.
