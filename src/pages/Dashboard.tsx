/**
 * Dashboard.
 *
 * Only figures derived from real saved data appear here. Metrics that need
 * Stage 5 (revenue, margin, ROI, time to sell) are listed as pending rather
 * than shown as zeroes, because a zero is indistinguishable from "no sales
 * recorded yet" and would quietly misrepresent the business.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  dashboardTotals, salesSummary, type DashboardTotals, type SalesSummary,
} from '../lib/db';
import { formatMoney } from '../lib/money';
import { marginPercent } from '../lib/profit';

export default function Dashboard() {
  const [t, setT] = useState<DashboardTotals | null>(null);
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([dashboardTotals(), salesSummary()])
      .then(([totals, s]) => { setT(totals); setSummary(s); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load totals.'));
  }, []);

  if (error) return <div className="note note-danger">{error}</div>;

  return (
    <>
      <div className="section-head">
        <h1>Dashboard</h1>
        <Link className="btn btn-primary btn-sm" to="/scan">+ Scan a card</Link>
      </div>

      {!t ? (
        <div className="stats">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <div className="k">Inventory cost</div>
              <div className="v">{formatMoney(t.totalCostCents)}</div>
              <div className="m">what you paid</div>
            </div>
            <div className="stat">
              <div className="k">Estimated value</div>
              <div className="v">
                {t.valuedItemCount > 0 ? formatMoney(t.totalValueCents) : '—'}
              </div>
              <div className="m">
                {t.valuedItemCount > 0
                  ? `${t.valuedItemCount} of ${t.itemCount} items priced`
                  : 'no items priced yet'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Items</div>
              <div className="v">{t.itemCount}</div>
              <div className="m">{t.cardCount} card{t.cardCount === 1 ? '' : 's'} total</div>
            </div>
            <div className="stat">
              <div className="k">Listed</div>
              <div className="v">{t.listedCount}</div>
              <div className="m">active listings</div>
            </div>
          </div>

          {(t.needsIdentification > 0 || t.needsConditionReview > 0) && (
            <div className="card mt">
              <h2>Needs your attention</h2>
              <div className="stack mt" style={{ gap: 7 }}>
                {t.needsIdentification > 0 && (
                  <div className="row between">
                    <span className="small">
                      <span className="badge badge-warn">{t.needsIdentification}</span>{' '}
                      item{t.needsIdentification === 1 ? '' : 's'} with no catalog match
                    </span>
                    <Link className="btn btn-sm" to="/inventory">Review</Link>
                  </div>
                )}
                {t.needsConditionReview > 0 && (
                  <div className="row between">
                    <span className="small">
                      <span className="badge badge-warn">{t.needsConditionReview}</span>{' '}
                      item{t.needsConditionReview === 1 ? '' : 's'} awaiting a condition grade
                    </span>
                    <Link className="btn btn-sm" to="/inventory">Review</Link>
                  </div>
                )}
              </div>
            </div>
          )}

          {t.itemCount === 0 && (
            <div className="empty mt">
              <div className="big">⊕</div>
              <p style={{ fontWeight: 600, color: 'var(--text)' }}>Your vault is empty.</p>
              <p className="small">
                Photograph a card, confirm what it is, enter what you paid, and save it.
              </p>
              <Link className="btn btn-primary mt" to="/scan">Scan your first card</Link>
            </div>
          )}
        </>
      )}

      {/* Trading performance, from recorded sales only. */}
      {summary && (
        summary.saleCount === 0 ? (
          <div className="card mt">
            <h2>Trading performance</h2>
            <p className="small muted" style={{ marginTop: 4 }}>
              No sales recorded yet, so revenue, profit and ROI have nothing to compute
              from. They are shown as dashes rather than zeroes — an empty figure and a
              real zero are not the same thing.
            </p>
            <Link className="btn btn-sm mt" to="/inventory">Record your first sale</Link>
          </div>
        ) : (
          <>
            <div className="section-head mt">
              <h2>Trading performance</h2>
              <Link className="small" to="/sales">All sales →</Link>
            </div>
            <div className="stats">
              <div className="stat">
                <div className="k">Gross revenue</div>
                <div className="v">
                  {formatMoney(summary.grossRevenueCents, summary.currency as 'USD')}
                </div>
                <div className="m">
                  {summary.saleCount} sale{summary.saleCount === 1 ? '' : 's'}
                </div>
              </div>
              <div className="stat">
                <div className="k">Net profit</div>
                <div className="v" style={{
                  color: summary.netProfitCents >= 0 ? 'var(--ok)' : 'var(--danger)',
                }}>
                  {formatMoney(summary.netProfitCents, summary.currency as 'USD')}
                </div>
                <div className="m">
                  {marginPercent(summary.netProfitCents, summary.grossRevenueCents) != null
                    ? `${marginPercent(summary.netProfitCents, summary.grossRevenueCents)!.toFixed(1)}% margin`
                    : '—'}
                </div>
              </div>
              <div className="stat">
                <div className="k">ROI</div>
                <div className="v">
                  {summary.roiPercent != null ? `${summary.roiPercent.toFixed(0)}%` : '—'}
                </div>
                <div className="m">
                  {summary.roiPercent != null ? 'on cost of cards sold' : 'no cost basis'}
                </div>
              </div>
              <div className="stat">
                <div className="k">Time to sell</div>
                <div className="v">
                  {summary.averageDaysToSell != null
                    ? `${Math.round(summary.averageDaysToSell)}d`
                    : '—'}
                </div>
                <div className="m">
                  {summary.byChannel[0]
                    ? `best: ${summary.byChannel[0].channel}`
                    : 'average'}
                </div>
              </div>
            </div>

            {summary.needsReviewCount > 0 && (
              <div className="note note-warn mt">
                <strong>{summary.needsReviewCount} sale
                {summary.needsReviewCount === 1 ? '' : 's'} flagged</strong> as a possible
                duplicate entry. <Link to="/sales">Review them</Link>.
              </div>
            )}
          </>
        )
      )}
    </>
  );
}
