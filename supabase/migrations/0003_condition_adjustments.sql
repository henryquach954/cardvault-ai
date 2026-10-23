-- Operator-supplied condition adjustments.
--
-- No connected price source provides condition-specific pricing: TCGdex,
-- Scryfall and YGOPRODeck all report a Near-Mint-anchored figure per finish.
-- Rather than show an NM price against a played card, or invent a discount,
-- the app applies the operator's OWN percentages and labels the result as a
-- derived estimate with low confidence.
--
-- These values are the operator's real buying behaviour, supplied 2026-10-22.
-- They are a default, not a constant: they are editable in Settings, and the
-- whole mechanism can be switched off.

alter table pricing_settings
  alter column condition_adjustments
  set default '{"LP": 85, "MP": 70, "HP": 50, "DMG": 30}'::jsonb;

alter table pricing_settings
  alter column apply_condition_adjustments
  set default true;

-- Backfill accounts created before this migration, without clobbering any
-- percentages the operator has already customised.
update pricing_settings
   set condition_adjustments = '{"LP": 85, "MP": 70, "HP": 50, "DMG": 30}'::jsonb,
       apply_condition_adjustments = true
 where condition_adjustments = '{}'::jsonb;

-- Guard rails. A percentage outside 1-100 is almost certainly a typo (someone
-- entering 0.85 instead of 85), and silently pricing a $300 card at under
-- three cents is exactly the kind of quiet corruption this schema exists to
-- prevent. NM is excluded deliberately: it is the anchor, always 100%.
--
-- A CHECK constraint may not contain a subquery, so the validation lives in an
-- IMMUTABLE function. CASE is used rather than AND so evaluation order is
-- guaranteed -- jsonb_each raises on a non-object, and SQL does not promise
-- short-circuiting of boolean operators.
create or replace function condition_adjustments_valid(adj jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when adj is null then true
    when jsonb_typeof(adj) <> 'object' then false
    when adj ? 'NM' or adj ? 'NEEDS_REVIEW' then false
    else coalesce((
      select bool_and(
        jsonb_typeof(e.value) = 'number'
        -- Lower bound is 1, not 0: the typo this is really guarding against is
        -- entering 0.85 instead of 85, which would price a $300 card at under
        -- three cents. A genuine sub-1% discount factor is not a real case.
        and (e.value #>> '{}')::numeric >= 1
        and (e.value #>> '{}')::numeric <= 100
      )
      from jsonb_each(adj) e
    ), true)   -- an empty object is valid: it simply disables adjustment
  end;
$$;

alter table pricing_settings
  add constraint pricing_condition_adjustments_sane
  check (condition_adjustments_valid(condition_adjustments));
