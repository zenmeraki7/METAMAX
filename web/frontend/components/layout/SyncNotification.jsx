import {useEffect, useRef, useState} from "react";
import useSyncProgress, {syncActive} from "../../hooks/useSyncProgress.js";

export function SyncProgressNotice({job,error}) {
  const observed = useRef(null);
  const [expanded, setExpanded] = useState(true);
  const [dismissed, setDismissed] = useState(null);
  const active = syncActive(job);
  const key = job?.id ?? "pending-install";
  useEffect(() => {
    if (active && observed.current !== key) {observed.current = key;setExpanded(true);}
  }, [active,key]);
  const attention = job?.reviewRequired || job?.status === "FAILED";
  if (!job || dismissed === key || (!active && !attention && observed.current !== key)) return null;
  const title = attention ? "Sync needs attention" : active ? "Syncing in progress" : job.status === "SUCCEEDED" ? "Sync complete" : "Sync cancelled";
  return <aside className="sync-notification" aria-label="Catalog sync notification">
    <button type="button" className="sync-notification__header" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className={`sync-notification__dot${attention ? " sync-notification__dot--warning" : ""}`} aria-hidden="true" />
      <strong>{title}</strong><span>{job.progress.percent}%</span><span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
    </button>
    {expanded && <div className="sync-notification__body">
      <div role="status" aria-live="polite" aria-atomic="true">
        <p>{job.progress.stage}</p>
        <progress max="100" value={job.progress.percent} aria-label="Estimated overall catalog sync progress" />
        <p className="sync-notification__detail">{job.progress.estimated ? "Estimated overall progress" : "Mirror published"} · {job.progress.percent}%</p>
      </div>
      {job.phase === "INGESTING" && job.progress.processedLines != null && <p className="sync-notification__detail">
        {job.progress.processedLines}{job.progress.expectedLines != null ? ` of ${job.progress.expectedLines}` : ""} export records saved
      </p>}
      {error && <p className="sync-notification__detail">Live updates temporarily unavailable. Retrying…</p>}
      {attention && <p className="sync-notification__detail">This sync needs review. Contact support if the problem continues.</p>}
      {!active && <button type="button" className="sync-notification__dismiss" onClick={() => setDismissed(key)}>Dismiss</button>}
    </div>}
  </aside>;
}

export default function SyncNotification() {
  return <SyncProgressNotice {...useSyncProgress()} />;
}
