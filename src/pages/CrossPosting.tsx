/**
 * Cross-Posting — the handoff workflow.
 *
 * The honest shape of this feature, verified 22 October 2026:
 *
 *   Facebook Marketplace  no public listing API for individual sellers
 *   Mercari               no public seller API
 *   eBay                  a real API exists, but needs a developer account,
 *                         production keys, business policies and an
 *                         inventory location before it can publish
 *
 * So this page does the only thing that genuinely works today: hands you
 * copy-ready text and a link to the right form. "Mark as posted" records the
 * URL of a listing YOU created and saw — the app never claims a listing is
 * live on its own say-so.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  currentUserId, deleteListing, listListings, updateListing,
  LISTING_STATUS_LABELS,
  type ListingFull, type ListingStatus,
} from '../lib/db';
import { MARKETPLACES, asPasteBlock, marketplaceSpec, type Marketplace } from '../lib/listing';
import { formatMoney } from '../lib/money';

const STATUS_BADGE: Partial<Record<ListingStatus, string>> = {
  draft: '',
  ready_to_publish: 'badge-info',
  published: 'badge-ok',
  failed: 'badge-danger',
  action_required: 'badge-warn',
  sold: 'badge-accent',
  ended: '',
};

export default function CrossPosting() {
  const [listings, setListings] = useState<ListingFull[] | null>(null);
  const [filter, setFilter] = useState<Marketplace | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [marking, setMarking] = useState<ListingFull | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      await currentUserId();
      setListings(await listListings({ status: 'all' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load listings.');
      setListings([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(
    () => (listings ?? []).filter((l) => filter === 'all' || l.marketplace === filter),
    [listings, filter]
  );

  async function copy(listing: ListingFull) {
    const block = asPasteBlock(
      {
        marketplace: listing.marketplace,
        title: listing.title ?? '',
        description: listing.description ?? '',
        keywords: listing.keywords ?? [],
        category: listing.category ?? '',
        conditionText: listing.condition_text ?? '',
        shippingNotes: listing.shipping_notes ?? '',
        titleTruncated: false,
      },
      listing.price_cents,
      listing.currency
    );
    try {
      await navigator.clipboard.writeText(block);
      setCopied(listing.id);
      setTimeout(() => setCopied(null), 2500);
    } catch {
      setError(
        'Your browser blocked clipboard access. Select the text in the preview and '
        + 'copy it manually.'
      );
    }
  }

  return (
    <>
      <div className="section-head">
        <h1>Cross-Posting</h1>
        <Link className="btn btn-primary btn-sm" to="/listings">+ New listing</Link>
      </div>

      {/* The honest capability statement, up front. */}
      <div className="card">
        <h2>What this can and cannot do</h2>
        <div className="scroll-x">
          <table className="data mt">
            <thead>
              <tr><th>Marketplace</th><th>Automated posting</th><th>Why</th></tr>
            </thead>
            <tbody>
              {MARKETPLACES.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 600 }}>{m.label}</td>
                  <td>
                    {m.canPublish
                      ? <span className="badge badge-ok">Connected</span>
                      : <span className="badge badge-warn">Manual</span>}
                  </td>
                  <td className="tiny">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note note-info mt">
          Copy the text, open the marketplace, paste, post. Then use
          <strong> Mark as posted</strong> and paste the URL so the app knows it is
          live — it will never claim that on its own.
        </div>
      </div>

      {error && <div className="note note-danger">{error}</div>}

      <div className="card card-tight">
        <div className="seg">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All ({listings?.length ?? 0})
          </button>
          {MARKETPLACES.map((m) => {
            const n = (listings ?? []).filter((l) => l.marketplace === m.id).length;
            return (
              <button
                key={m.id} type="button"
                aria-pressed={filter === m.id}
                onClick={() => setFilter(m.id)}
              >
                {m.label} ({n})
              </button>
            );
          })}
        </div>
      </div>

      {listings === null && <div className="skeleton mt" style={{ height: 120 }} />}

      {listings?.length === 0 && (
        <div className="empty">
          <div className="big">⇄</div>
          <p style={{ fontWeight: 600, color: 'var(--text)' }}>No listing drafts yet.</p>
          <p className="small">
            Generate copy for a card and it will appear here, ready to paste.
          </p>
          <Link className="btn btn-primary btn-sm mt" to="/listings">Create a listing</Link>
        </div>
      )}

      <div className="stack mt" style={{ gap: 7 }}>
        {shown.map((listing) => {
          const spec = marketplaceSpec(listing.marketplace);
          return (
            <div key={listing.id} className="card card-tight" style={{ marginTop: 0 }}>
              <div className="row between">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 640, fontSize: '0.9rem' }}>
                    {listing.title ?? '(no title)'}
                  </div>
                  <div className="tiny muted">
                    {spec.label}
                    {listing.card_name && ` · ${listing.card_name}`}
                    {listing.lot_title && ` · lot: ${listing.lot_title}`}
                  </div>
                  <div className="row row-tight" style={{ marginTop: 4 }}>
                    <span className={`badge ${STATUS_BADGE[listing.status] ?? ''}`}>
                      {LISTING_STATUS_LABELS[listing.status]}
                    </span>
                    {listing.published_url && (
                      <a
                        className="badge badge-ok" href={listing.published_url}
                        target="_blank" rel="noreferrer"
                      >
                        view live
                      </a>
                    )}
                  </div>
                </div>
                <div className="right nowrap">
                  <div style={{ fontWeight: 650 }}>
                    {listing.price_cents != null
                      ? formatMoney(listing.price_cents, listing.currency as 'USD')
                      : <span className="dim small">no price</span>}
                  </div>
                </div>
              </div>

              {listing.last_error && (
                <div className="note note-danger" style={{ marginTop: 7 }}>
                  {listing.last_error}
                </div>
              )}

              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-sm" onClick={() => copy(listing)}>
                  {copied === listing.id ? '✓ Copied' : 'Copy listing'}
                </button>
                <a
                  className="btn btn-sm" href={spec.manualUrl}
                  target="_blank" rel="noreferrer"
                >
                  Open {spec.label}
                </a>
                {listing.status !== 'published' ? (
                  <button className="btn btn-sm" onClick={() => setMarking(listing)}>
                    Mark as posted
                  </button>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      await updateListing(listing.id, {
                        status: 'ended',
                        last_synced_at: new Date().toISOString(),
                      });
                      load();
                    }}
                  >
                    Mark ended
                  </button>
                )}
                <div style={{ flex: 1 }} />
                <button
                  className="btn btn-ghost btn-sm"
                  aria-label="Delete draft"
                  onClick={async () => {
                    if (!confirm('Delete this draft? The card itself is unaffected.')) return;
                    await deleteListing(listing.id);
                    load();
                  }}
                >×</button>
              </div>

              <details style={{ marginTop: 8 }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>
                  Preview the text
                </summary>
                <pre
                  className="tiny mono mt"
                  style={{
                    whiteSpace: 'pre-wrap', background: 'var(--surface-2)',
                    padding: 10, borderRadius: 7, margin: 0, maxHeight: 280,
                    overflowY: 'auto',
                  }}
                >
                  {listing.description ?? ''}
                </pre>
              </details>
            </div>
          );
        })}
      </div>

      {marking && (
        <MarkPostedDialog
          listing={marking}
          onClose={() => setMarking(null)}
          onDone={() => { setMarking(null); load(); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Record that the operator posted this by hand.
 *
 * The URL is required. It is the evidence that a real listing exists, and
 * without it the database refuses to accept the Published status — that
 * CHECK constraint is what stops the app ever reporting a listing as live on
 * nothing more than a button press.
 */
function MarkPostedDialog({
  listing, onClose, onDone,
}: {
  listing: ListingFull; onClose: () => void; onDone: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const looksValid = /^https?:\/\/.+\..+/.test(url.trim());

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Mark as posted</h2>
        <p className="small muted mt">
          Paste the URL of the listing you just created on
          {' '}{marketplaceSpec(listing.marketplace).label}. The app records it as
          Published only with a real link — it will not take your word for it, and
          neither should you.
        </p>

        <label className="field mt">
          <span className="label-text">Listing URL</span>
          <input
            type="url" value={url} autoFocus placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
          />
          {url.trim() && !looksValid && (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              That does not look like a web address.
            </span>
          )}
        </label>

        {error && <div className="note note-danger mt">{error}</div>}

        <div className="row mt">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy || !looksValid}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await updateListing(listing.id, {
                  status: 'published',
                  published_url: url.trim(),
                  // The URL is the external identifier for a manual post.
                  external_listing_id: url.trim(),
                  published_at: new Date().toISOString(),
                  last_synced_at: new Date().toISOString(),
                  last_error: null,
                });
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not update the listing.');
                setBusy(false);
              }
            }}
          >
            {busy && <span className="spinner" />} Mark as posted
          </button>
        </div>
      </div>
    </div>
  );
}
