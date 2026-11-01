import { formatSyncTime } from "../../utils/formatSyncTime.js";
const sourceIcons = {
  tag: "tag",
  layers: "collection",
  map: "location",
  receipt: "order",
  box: "product",
  bag: "cart",
  code: "code",
  globe: "globe",
  package: "product",
};
export default function SyncSourceRow({
  source,
  timeZone,
  busy,
  disabled,
  onRefresh,
}) {
  const Icon = sourceIcons[source.icon] ?? "product";
  const automatic = source.syncType === "automatic";
  const unavailable = source.status === "unavailable";
  const failed = source.status === "failed";
  const running = ["queued", "running"].includes(source.status);
  return (
    <s-table-row key={source.id}>
      <s-table-cell>
        <s-stack
          class="sd-source-name"
          direction="inline"
          gap="base"
          alignItems="center"
        >
          <s-stack
            class="sd-source-icon"
            direction="inline"
            gap="small"
            alignItems="center"
          >
            <s-icon type={Icon} />
          </s-stack>

          <s-text>{source.name}</s-text>
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-badge
          tone={unavailable ? "neutral" : automatic ? "success" : "info"}
          icon={automatic ? "refresh" : "clock"}
        >
          {unavailable ? "Unavailable" : automatic ? "Automatic" : "Periodic"}
        </s-badge>

        {failed && <s-badge tone="critical">Failed</s-badge>}

        {running && <s-badge tone="info">Syncing</s-badge>}
        {source.status === "cancelled" && <s-badge tone="warning">Cancelled</s-badge>}
      </s-table-cell>

      <s-table-cell class="sd-source-time">
        <time dateTime={source.lastFullSyncAt || undefined}>
          {formatSyncTime(source.lastFullSyncAt, timeZone)}
        </time>
      </s-table-cell>

      <s-table-cell class="sd-source-actions">
        <s-button
          variant="tertiary"
          onClick={() => onRefresh(source.id)}
          disabled={disabled || busy || source.supported === false}
          loading={busy}
          accessibilityLabel={`Refresh ${source.name}`}
        >
          Refresh
        </s-button>
      </s-table-cell>
    </s-table-row>
  );
}
export { SyncSourceRow };
