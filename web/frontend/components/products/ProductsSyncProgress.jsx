import {syncActive} from "../../hooks/useSyncProgress.js";
import {useSharedSyncProgress} from "../../hooks/SyncProgressContext.js";

const formatCount = value => /^\d+$/.test(String(value ?? "")) ? new Intl.NumberFormat("en-US").format(BigInt(value)) : null;

export function ProductSyncStatus({job,error,lastUpdatedAt,accessDenied}) {
  if (!job) return error ? <s-banner heading={accessDenied ? "Sync access needs renewal" : "Live sync updates unavailable"} tone="warning">{accessDenied ? "Reopen the app to verify your access to catalog sync." : "Reconnecting automatically. Your last published catalog is unchanged."}</s-banner> : null;
  const active = syncActive(job);
  const paused = job.status === "RETRY" || job.reviewRequired || job.outcomeUncertain;
  const complete = job.status === "SUCCEEDED" && job.progress.percent === 100;
  const moving = active && !paused && !error;
  const count = formatCount(job.progress.productsSaved);
  const title = complete ? "Your catalog is up to date" : job.reviewRequired || job.status === "FAILED" ? "Sync needs attention" : job.status === "CANCELLED" ? "Sync cancelled" : paused ? "Sync paused" : "Syncing your products";
  return <s-section padding="none" accessibilityLabel="Live catalog sync">
    <div className="products-sync">
      <div className="products-sync__top">
        <s-stack direction="inline" gap="small" alignItems="center">
        {moving && <s-spinner size="small" accessibilityLabel="Sync in progress" />}
        <s-text type="strong">{title}</s-text>
        <s-badge tone={complete ? "success" : paused || error ? "warning" : "info"}>{error ? "Reconnecting" : complete ? "Complete" : moving ? "Live updates" : "Status updates"}</s-badge>
        </s-stack>
      <div className="products-sync__numbers" role="status" aria-live="polite" aria-atomic="true">
        <strong>{count ?? "—"}</strong>
        <s-text color="subdued">{count === null ? "Waiting for a saved product count" : complete ? "products in your synced catalog" : "products saved to this sync"}</s-text>
      </div>
      <s-text color="subdued">{job.progress.percent}%{job.progress.estimated ? " estimated" : ""}</s-text>
      <details className="products-sync__details">
        <summary>Details</summary>
        <div className="products-sync__detail-panel">
          <s-stack gap="small">
            <s-text>{job.progress.stage}</s-text>
            <s-text color="subdued">{error ? "Connection interrupted. Showing the last confirmed count; retrying automatically." : active ? "Updates automatically every 3 seconds while connected." : "Checking automatically for the next sync."}</s-text>
            {!complete && <s-text color="subdued">Products become available here once this catalog has been verified and published.</s-text>}
            {lastUpdatedAt && <s-text color="subdued">Last checked at {new Date(lastUpdatedAt).toLocaleTimeString()}.</s-text>}
          </s-stack>
        </div>
      </details>
      </div>
      <div className={`products-sync__track${moving ? " products-sync__track--active" : ""}`}>
        <progress max="100" value={job.progress.percent} aria-label="Estimated overall sync progress" />
      </div>
    </div>
  </s-section>;
}

export default function ProductsSyncProgress() {
  return <ProductSyncStatus {...useSharedSyncProgress()} />;
}
