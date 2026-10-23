/**
 * Catalog search: name → candidates → exact printing.
 *
 * Shared by the Scan workflow and the standalone Price Research lookup. The
 * two screens need identical identification behaviour, and a second copy of
 * this logic would inevitably drift -- one of them would end up auto-selecting
 * a printing, or showing rarity it had not actually fetched.
 *
 * The rule it enforces, in both places: a catalog match is a *candidate* until
 * the operator picks it. Nothing auto-selects except when there is genuinely
 * nothing to choose between.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { GAMES, catalogProviderFor } from '../providers/registry';
import { TCGDEX_LANGUAGES } from '../providers/catalog/tcgdex';
import type { CardCandidate, TcgGame } from '../providers/types';

export function describeCandidate(c: CardCandidate): string {
  return [
    c.setName ?? c.setCode,
    c.collectorNumber ? `#${c.collectorNumber}${c.setTotal ? `/${c.setTotal}` : ''}` : null,
    c.rarity,
    c.finish,
  ].filter(Boolean).join(' · ');
}

export default function CardSearch({
  game,
  onGameChange,
  selected,
  onSelect,
  footer,
  noProviderHint,
}: {
  game: TcgGame;
  onGameChange: (g: TcgGame) => void;
  /** The confirmed printing, or null. Owned by the parent. */
  selected: CardCandidate | null;
  onSelect: (c: CardCandidate | null) => void;
  /** Extra controls rendered beneath the search (e.g. "Needs identification"). */
  footer?: ReactNode;
  /** Shown when the chosen game has no free catalog provider. */
  noProviderHint?: ReactNode;
}) {
  const [language, setLanguage] = useState('en');
  const [term, setTerm] = useState('');
  const [number, setNumber] = useState('');

  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CardCandidate[] | null>(null);

  const [chosen, setChosen] = useState<CardCandidate | null>(null);
  const [printings, setPrintings] = useState<CardCandidate[] | null>(null);

  const provider = useMemo(() => catalogProviderFor(game), [game]);
  const abortRef = useRef<AbortController | null>(null);

  // A Pokémon match is meaningless once the operator says it is a Magic card.
  //
  // Guarded by comparing the PREVIOUS game rather than an "is first run"
  // flag. A parent may mount this with a card already selected (Price
  // Research hands one to Scan via "Add to inventory"), and resetting on
  // mount would silently throw that selection away.
  //
  // A first-run flag is not sufficient: StrictMode deliberately invokes
  // effects twice in development, so the flag is already false on the second
  // pass and the reset fires anyway. Comparing the value is immune to that,
  // because the game genuinely has not changed between the two runs.
  const prevGame = useRef(game);
  useEffect(() => {
    if (prevGame.current === game) return;
    prevGame.current = game;

    setCandidates(null);
    setChosen(null);
    setPrintings(null);
    setError(null);
    onSelect(null);
    // onSelect is intentionally omitted: parents commonly pass an inline
    // arrow, and including it would clear the selection on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  const runSearch = useCallback(async () => {
    if (!provider || term.trim().length < 2) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSearching(true);
    setError(null);
    setChosen(null);
    setPrintings(null);
    onSelect(null);

    try {
      const results = await provider.search({
        game,
        name: term.trim(),
        collectorNumber: number.trim() || undefined,
        language,
        limit: 24,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setCandidates(results);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof Error ? `${provider.label} search failed: ${err.message}` : 'Search failed.'
      );
      setCandidates([]);
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, term, number, language, game]);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    if (term.trim().length < 2) {
      setCandidates(null);
      return;
    }
    const t = setTimeout(runSearch, 350);
    return () => clearTimeout(t);
  }, [term, number, language, runSearch]);

  async function pickCandidate(c: CardCandidate) {
    setChosen(c);
    setPrintings(null);
    onSelect(null);

    if (!provider?.listPrintings) {
      onSelect(c);
      return;
    }
    try {
      const list = await provider.listPrintings(c.externalId, language);
      setPrintings(list);
      if (list.length === 1) onSelect(list[0]);
    } catch {
      onSelect(c); // fall back to the base match rather than blocking
    }
  }

  return (
    <>
      <label className="field">
        <span className="label-text">Game</span>
        <select value={game} onChange={(e) => onGameChange(e.target.value as TcgGame)}>
          {GAMES.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}{g.catalog ? '' : ' — manual entry only'}
            </option>
          ))}
        </select>
      </label>

      {!provider ? (
        noProviderHint ?? (
          <div className="note note-warn">
            There is no free catalog API for {GAMES.find((g) => g.value === game)?.label}.
          </div>
        )
      ) : (
        <>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: '2 1 200px' }}>
              <span className="label-text">Card name</span>
              <input
                type="search" value={term} placeholder="e.g. Charizard ex"
                autoComplete="off"
                onChange={(e) => setTerm(e.target.value)}
              />
            </label>
            <label className="field" style={{ flex: '1 1 110px' }}>
              <span className="label-text">Number</span>
              <input
                type="text" value={number} placeholder="199" inputMode="numeric"
                onChange={(e) => setNumber(e.target.value)}
              />
            </label>
            {game === 'pokemon' && (
              <label className="field" style={{ flex: '1 1 130px' }}>
                <span className="label-text">Language</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {TCGDEX_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <p className="tiny dim" style={{ marginTop: -4 }}>
            Catalog:{' '}
            <a href={provider.homepage} target="_blank" rel="noreferrer">{provider.label}</a>
            {' · '}free, no account needed
          </p>

          {searching && (
            <div className="row small muted mt"><span className="spinner" /> Searching…</div>
          )}
          {error && <div className="note note-danger mt">{error}</div>}

          {candidates && candidates.length === 0 && !searching && (
            <div className="note note-warn mt">
              No match in {provider.label}. Check the spelling, or try the collector number.
            </div>
          )}

          {candidates && candidates.length > 0 && !chosen && (
            <>
              <h3 className="mt">
                {candidates.length} possible match{candidates.length === 1 ? '' : 'es'}
              </h3>
              <p className="tiny dim">
                These are candidates from the catalog, not a decision. Pick the one in your hand.
              </p>
              <div className="stack" style={{ gap: 6 }}>
                {candidates.map((c, i) => (
                  <button
                    key={`${c.externalId}-${i}`} type="button" className="candidate"
                    onClick={() => pickCandidate(c)}
                  >
                    {c.imageUrl
                      ? <img src={c.imageUrl} alt="" loading="lazy" />
                      : <div className="ph">no image</div>}
                    <div>
                      <div style={{ fontWeight: 620, fontSize: '0.88rem' }}>{c.name}</div>
                      <div className="tiny muted">{describeCandidate(c) || '—'}</div>
                    </div>
                    <span className="badge">Select</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {chosen && (
            <div className="mt">
              <div className="row between">
                <h3>Which printing?</h3>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setChosen(null); setPrintings(null); onSelect(null); }}
                >
                  Change card
                </button>
              </div>

              {!printings && (
                <div className="row small muted"><span className="spinner" /> Loading printings…</div>
              )}

              {printings && printings.length > 1 && (
                <p className="tiny dim">
                  This card exists in {printings.length} finishes. They are different objects
                  at different prices, so pick the exact one.
                </p>
              )}

              <div className="stack" style={{ gap: 6 }}>
                {(printings ?? []).map((p, i) => (
                  <button
                    key={`${p.externalId}-${i}`}
                    type="button"
                    className="candidate"
                    aria-pressed={selected === p}
                    onClick={() => onSelect(p)}
                  >
                    {p.imageUrl
                      ? <img src={p.imageUrl} alt="" loading="lazy" />
                      : <div className="ph">no image</div>}
                    <div>
                      <div style={{ fontWeight: 620, fontSize: '0.88rem' }}>
                        {p.finish ?? 'Standard'}
                      </div>
                      <div className="tiny muted">{describeCandidate(p)}</div>
                    </div>
                    {selected === p
                      ? <span className="badge badge-accent">Confirmed</span>
                      : <span className="badge">Select</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {footer}
    </>
  );
}
