import HistoryActionMenu from "./HistoryActionMenu.jsx";
const icons = {
  Edit: "edit",
  Export: "download",
  Import: "upload",
  File: "note",
};
const typeLabels = {
  Edit: "Edit",
  Export: "Export",
  Import: "Import",
  File: "File",
};
const statusTones = {
  Completed: "success",
  Cancelled: "neutral",
  Failed: "critical",
};
export default function HistoryRow({
  item,
  selected,
  onSelect,
  onView,
  onCopy,
  onRetry,
  checkboxId,
}) {
  const Icon = icons[item.type];
  return (
    <s-table-row clickDelegate={checkboxId}>
      <s-table-cell>
        <s-stack
          class="mh-operation-title"
          direction="inline"
          gap="base"
          alignItems="center"
        >
          <s-checkbox
            id={checkboxId}
            accessibilityLabel={`Select ${item.title}`}
            checked={selected}
            onChange={(event) => onSelect(item.id, event.currentTarget.checked)}
          />

          <s-stack
            class={`mh-operation-icon mh-operation-icon--${item.type.toLowerCase()}`}
            direction="inline"
            gap="small"
            alignItems="center"
          >
            <s-icon type={Icon} />
          </s-stack>

          <s-button
            class="mh-title-button"
            onClick={(event) => {
              event.stopPropagation();
              onView(item);
            }}
          >
            {item.title}
          </s-button>
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-text class={`mh-type mh-type--${item.type.toLowerCase()}`}>
          {typeLabels[item.type]}
        </s-text>
      </s-table-cell>

      <s-table-cell>
        <s-badge
          tone={statusTones[item.status]}
          icon={
            item.status === "Completed"
              ? "check-circle"
              : item.status === "Failed"
                ? "alert-circle"
                : "x-circle"
          }
        >
          {item.status}
        </s-badge>
      </s-table-cell>

      <s-table-cell>
        <s-stack class="mh-progress" gap="base">
          <s-text>
            {item.processed.toLocaleString("en-US")} /{" "}
            {item.total.toLocaleString("en-US")}
          </s-text>

          <progress
            value={item.processed}
            max={item.total}
            aria-label={`${item.title} progress`}
          ></progress>
        </s-stack>
      </s-table-cell>

      <s-table-cell class="mh-nowrap">{item.user}</s-table-cell>

      <s-table-cell class="mh-nowrap">
        <time dateTime={item.startedAt}>{item.startedLabel}</time>
      </s-table-cell>

      <s-table-cell class="mh-nowrap">{item.duration}</s-table-cell>

      <s-table-cell class="mh-cell-actions">
        <s-stack gap="base">
          <HistoryActionMenu
            item={item}
            onView={onView}
            onCopy={onCopy}
            onRetry={onRetry}
          />
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}
export { HistoryRow };
