import useModalOverlay from "../../hooks/useModalOverlay.js";
import { useRef } from "react";
export default function HistoryDetailDialog({ operation, onClose, isDemo }) {
  const dialogRef = useRef(null);
  useModalOverlay(dialogRef, Boolean(operation), onClose);
  const isDemoRecord = Boolean(isDemo || operation?.isDemo);
  return (
    <s-modal ref={dialogRef} id="history-details" heading={"Operation details"}>
      {operation && (
        <>
          <s-heading>{operation.title}</s-heading>

          <dl className="mh-detail-list">
            <dt>Operation ID</dt>
            <dd>{operation.id}</dd>

            <dt>Type</dt>
            <dd>{operation.type}</dd>

            <dt>Status</dt>
            <dd>{operation.status}</dd>

            <dt>{operation.countUnit === 'fields' ? 'Field verification' : 'Progress'}</dt>
            <dd>
              {operation.processed?.toLocaleString?.() ?? operation.processed} /{" "}
              {operation.total?.toLocaleString?.() ?? operation.total}
            </dd>

            {operation.failedCount !== undefined && <>
              <dt>{operation.countUnit === 'fields' ? 'Verified fields' : 'Verified changes'}</dt><dd>{operation.processed.toLocaleString("en-US")}</dd>
              <dt>{operation.countUnit === 'fields' ? 'Failed fields' : 'Failed changes'}</dt><dd>{operation.failedCount.toLocaleString("en-US")}</dd>
              <dt>{operation.countUnit === 'fields' ? 'Recorded fields' : 'Total changes'}</dt><dd>{operation.total.toLocaleString("en-US")}</dd>
            </>}
            {operation.uncertainCount > 0 && <><dt>Uncertain changes</dt><dd>{operation.uncertainCount.toLocaleString("en-US")}</dd></>}

            <dt>Started at</dt>
            <dd>{operation.startedLabel || operation.startedAt || "—"}</dd>

            <dt>Duration</dt>
            <dd>{operation.duration || "—"}</dd>

            <dt>User</dt>
            <dd>{operation.user || "—"}</dd>
          </dl>

          {isDemoRecord && (
            <s-paragraph class="mh-dialog__note">
              This is a demo record. Actual execution logs, Shopify API errors,
              and undo information should come from your backend.
            </s-paragraph>
          )}
        </>
      )}
      <s-button
        slot="secondary-actions"
        commandFor="history-details"
        command="--hide"
      >
        Done
      </s-button>
    </s-modal>
  );
}
