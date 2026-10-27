import useModalOverlay from "../../hooks/useModalOverlay.js";
import { useRef } from "react";
export default function HistoryDetailDialog({ operation, onClose }) {
  const dialogRef = useRef(null);
  useModalOverlay(dialogRef, Boolean(operation), onClose);
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

            <dt>Progress</dt>
            <dd>
              {operation.processed.toLocaleString()} /{" "}
              {operation.total.toLocaleString()}
            </dd>

            <dt>Started at</dt>
            <dd>{operation.startedLabel}</dd>

            <dt>Duration</dt>
            <dd>{operation.duration}</dd>

            <dt>User</dt>
            <dd>{operation.user}</dd>
          </dl>

          <s-paragraph class="mh-dialog__note">
            This is a demo record. Actual execution logs, Shopify API errors,
            and undo information should come from your backend.
          </s-paragraph>
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
