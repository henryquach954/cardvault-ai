/**
 * Scan a Card — the Stage 1 intake workflow.
 *
 * Photograph → identify → confirm → cost → save. The ordering is deliberate:
 * photos first because that is the part that must happen while the card is in
 * hand, and identification second because it is the part that can be corrected
 * later.
 *
 * The identification rule this screen enforces: a catalog match is a
 * *candidate* until the operator picks it. Nothing auto-selects, nothing is
 * saved on a guess, and a card that cannot be identified is saved honestly as
 * "Needs identification" rather than attached to a plausible-looking match.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import PhotoCapture, { type CapturedPhoto } from '../components/PhotoCapture';
import CardSearch, { describeCandidate } from '../components/CardSearch';
import { CONDITIONS, DEFECT_FLAGS, type CardCandidate, type CardCondition, type TcgGame } from '../providers/types';
import { GAMES } from '../providers/registry';
import {
  attachImages, createInventoryItem, currentUserId, discardUploads, ensureCatalogCard,
  type ItemKind,
} from '../lib/db';
import { parseMoney } from '../lib/money';
import { newId } from '../lib/id';

const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ACE', 'Other'];

/** What Price Research hands over via "Add to inventory". */
interface ScanPrefill {
  candidate?: CardCandidate;
  condition?: CardCondition;
  kind?: ItemKind;
  gradingCompany?: string | null;
  grade?: string | null;
}

export default function Scan() {
  const navigate = useNavigate();
  const prefill = (useLocation().state ?? null) as ScanPrefill | null;

  // The item id is generated up front so photos can upload to their final
  // path before the row exists. See PhotoCapture for why.
  const [itemId] = useState(() => newId());
  const [userId, setUserId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);

  const [game, setGame] = useState<TcgGame>(prefill?.candidate?.game ?? 'pokemon');
  const [printing, setPrinting] = useState<CardCandidate | null>(prefill?.candidate ?? null);
  const [unidentified, setUnidentified] = useState(false);

  const [kind, setKind] = useState<ItemKind>(prefill?.kind ?? 'raw_single');
  const [condition, setCondition] = useState<CardCondition>(
    prefill?.condition ?? 'NEEDS_REVIEW'
  );
  const [defects, setDefects] = useState<Record<string, boolean>>({});
  const [conditionNotes, setConditionNotes] = useState('');
  const [gradingCompany, setGradingCompany] = useState(prefill?.gradingCompany ?? 'PSA');
  const [grade, setGrade] = useState(prefill?.grade ?? '');
  const [certNumber, setCertNumber] = useState('');

  const [quantity, setQuantity] = useState('1');
  const [cost, setCost] = useState('');
  const [acquiredOn, setAcquiredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState('');
  const [location, setLocation] = useState('');
  const [sku, setSku] = useState('');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    currentUserId().then(setUserId).catch(() => setUserId(null));
  }, []);

  const confirmed = unidentified ? null : printing;
  const canSave =
    !!userId && (unidentified || !!confirmed) &&
    (kind !== 'graded_slab' || (!!gradingCompany && !!grade));

  async function save() {
    if (!userId) return;
    setSaving(true);
    setSaveError(null);

    try {
      let catalogCardId: string | null = null;
      if (confirmed) {
        const row = await ensureCatalogCard(confirmed, userId);
        catalogCardId = row.id;
      }

      const qty = Math.max(1, Number(quantity) || 1);
      await createInventoryItem(
        {
          id: itemId,
          catalogCardId,
          kind,
          condition: kind === 'graded_slab' ? 'NM' : condition,
          conditionNotes: conditionNotes || null,
          defects,
          quantity: kind === 'graded_slab' ? 1 : qty,
          currency: 'USD',
          purchaseCostCents: parseMoney(cost),
          acquisitionDate: acquiredOn || null,
          acquisitionSource: source || null,
          storageLocation: location || null,
          sku: sku || null,
          notes: notes || null,
          gradingCompany: kind === 'graded_slab' ? gradingCompany : null,
          grade: kind === 'graded_slab' ? Number(grade) : null,
          certNumber: kind === 'graded_slab' ? certNumber : null,
        },
        userId
      );

      await attachImages(
        itemId, userId,
        photos.map((p, i) => ({ path: p.path, face: p.face, sortOrder: i }))
      );

      navigate(`/inventory/${itemId}`, { replace: true });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this card.');
      setSaving(false);
    }
  }

  async function discard() {
    if (photos.length && !confirm('Discard this scan and delete the photos you uploaded?')) return;
    await discardUploads(photos.map((p) => p.path)).catch(() => {});
    navigate('/inventory');
  }

  return (
    <>
      <div className="section-head">
        <h1>Scan a Card</h1>
        <span className="sub">One card at a time</span>
      </div>

      {/* 1 — Photos ------------------------------------------------------- */}
      <div className="card">
        <h2>1. Photograph the card</h2>
        <p className="small muted" style={{ marginTop: 4 }}>
          Front and back. On a phone this opens the camera directly.
        </p>
        {userId ? (
          <PhotoCapture itemId={itemId} userId={userId} photos={photos} onChange={setPhotos} />
        ) : (
          <div className="skeleton" style={{ height: 180 }} />
        )}
      </div>

      {/* 2 — Identify ----------------------------------------------------- */}
      <div className="card">
        <h2>2. Identify the card</h2>

        {prefill?.candidate && printing === prefill.candidate && (
          <div className="note note-ok mt">
            Carried over from Price Research:{' '}
            <strong>{prefill.candidate.name}</strong> — {describeCandidate(prefill.candidate)}.
            Search below to change it.
          </div>
        )}

        <CardSearch
          game={game}
          onGameChange={setGame}
          selected={printing}
          onSelect={setPrinting}
          noProviderHint={
            <div className="note note-warn">
              There is no free catalog API for {GAMES.find((g) => g.value === game)?.label}.
              Save the card as <strong>Needs identification</strong> below and fill in the
              details yourself, or add a paid provider in Settings.
            </div>
          }
          footer={
            <div className="mt">
              <label className="row small" style={{ gap: 7 }}>
                <input
                  type="checkbox" checked={unidentified} style={{ width: 16, minHeight: 0 }}
                  onChange={(e) => {
                    setUnidentified(e.target.checked);
                    if (e.target.checked) setPrinting(null);
                  }}
                />
                <span>
                  Save as <strong>Needs identification</strong> — I will work out what this is later
                </span>
              </label>
            </div>
          }
        />
      </div>

      {/* 3 — Condition and cost ------------------------------------------- */}
      <div className="card">
        <h2>3. Condition and cost</h2>

        <div className="seg mt mb">
          {([['raw_single', 'Raw single'], ['graded_slab', 'Graded slab'],
             ['sealed_product', 'Sealed'], ['bulk_group', 'Bulk group']] as const).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={kind === v} onClick={() => setKind(v)}>
              {l}
            </button>
          ))}
        </div>

        {kind === 'graded_slab' ? (
          <>
            <div className="note note-info mb">
              Grades are transcribed from the slab label, never inferred from a photograph.
            </div>
            <div className="grid grid-2">
              <label className="field">
                <span className="label-text">Grading company</span>
                <select value={gradingCompany} onChange={(e) => setGradingCompany(e.target.value)}>
                  {GRADERS.map((g) => <option key={g}>{g}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="label-text">Grade</span>
                <input
                  type="number" step="0.5" min="0" max="10" value={grade}
                  onChange={(e) => setGrade(e.target.value)} placeholder="10"
                />
              </label>
            </div>
            <label className="field">
              <span className="label-text">Certification number</span>
              <input
                type="text" value={certNumber} onChange={(e) => setCertNumber(e.target.value)}
                placeholder="As printed on the label"
              />
              <span className="hint">
                Stored so the same slab cannot be entered or sold twice.
              </span>
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span className="label-text">Condition</span>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as CardCondition)}
              >
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <span className="hint">
                {CONDITIONS.find((c) => c.value === condition)?.hint}
              </span>
            </label>

            <div className="field">
              <span className="label-text">Visible defects</span>
              <div className="seg">
                {DEFECT_FLAGS.map((d) => (
                  <button
                    key={d} type="button" aria-pressed={!!defects[d]}
                    onClick={() => setDefects((p) => ({ ...p, [d]: !p[d] }))}
                  >
                    {d.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            </div>

            <label className="field">
              <span className="label-text">Condition notes</span>
              <textarea
                value={conditionNotes} onChange={(e) => setConditionNotes(e.target.value)}
                placeholder="e.g. light whitening on the bottom-left corner"
              />
            </label>
          </>
        )}

        <div className="grid grid-2">
          <label className="field">
            <span className="label-text">Purchase cost</span>
            <input
              type="text" inputMode="decimal" value={cost} placeholder="0.00"
              onChange={(e) => setCost(e.target.value)}
            />
            <span className="hint">Leave blank if unknown — blank is not the same as free.</span>
          </label>
          <label className="field">
            <span className="label-text">Quantity</span>
            <input
              type="number" min="1" value={kind === 'graded_slab' ? '1' : quantity}
              disabled={kind === 'graded_slab'}
              onChange={(e) => setQuantity(e.target.value)}
            />
            {kind === 'graded_slab' && (
              <span className="hint">A slab is a unique object, so quantity is always 1.</span>
            )}
          </label>
        </div>

        <div className="grid grid-2">
          <label className="field">
            <span className="label-text">Acquired on</span>
            <input type="date" value={acquiredOn} onChange={(e) => setAcquiredOn(e.target.value)} />
          </label>
          <label className="field">
            <span className="label-text">Acquired from</span>
            <input
              type="text" value={source} onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. local card show"
            />
          </label>
        </div>

        <div className="grid grid-2">
          <label className="field">
            <span className="label-text">Storage location</span>
            <input
              type="text" value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Box 3, row B"
            />
          </label>
          <label className="field">
            <span className="label-text">SKU</span>
            <input
              type="text" value={sku} onChange={(e) => setSku(e.target.value)}
              placeholder="Optional"
            />
          </label>
        </div>

        <label className="field">
          <span className="label-text">Private notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>

      {saveError && <div className="note note-danger mt">{saveError}</div>}

      {/* Summary of what will actually be saved. */}
      <div className="card card-tight mt">
        <div className="tiny dim">Will be saved as</div>
        <div style={{ fontWeight: 620 }}>
          {confirmed
            ? `${confirmed.name} — ${describeCandidate(confirmed)}`
            : unidentified
              ? 'Needs identification'
              : 'No card confirmed yet'}
        </div>
        <div className="tiny muted mt">
          {photos.length} photo{photos.length === 1 ? '' : 's'}
          {' · '}{kind === 'graded_slab'
            ? `${gradingCompany} ${grade || '—'}`
            : CONDITIONS.find((c) => c.value === condition)?.label}
          {cost && ` · cost ${cost}`}
        </div>
      </div>

      <div className="sticky-actions mt">
        <button className="btn" onClick={discard} disabled={saving}>Discard</button>
        <button className="btn btn-primary" onClick={save} disabled={!canSave || saving}>
          {saving && <span className="spinner" />}
          {saving ? 'Saving…' : 'Save to inventory'}
        </button>
      </div>

      {!canSave && !saving && (
        <p className="tiny dim mt">
          {kind === 'graded_slab' && (!gradingCompany || !grade)
            ? 'Enter the grading company and grade to save this slab.'
            : 'Confirm which card this is, or tick “Needs identification”, to save.'}
        </p>
      )}
    </>
  );
}
