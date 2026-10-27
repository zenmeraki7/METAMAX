import { formatSyncTime, formatTimeZone } from "../../utils/formatSyncTime.js";
function SummaryCard({ icon: Icon, tone, label, value, description }) {
  return (
    <s-section class="sd-summary-card">
      <s-stack gap="base">
        <s-stack class={`sd-summary-card__icon sd-tone--${tone}`} gap="base">
          <s-icon type={Icon} />
        </s-stack>

        <s-stack class="sd-summary-card__body" gap="base">
          <s-text class="sd-summary-card__label">{label}</s-text>

          <s-text class="sd-summary-card__value" type="strong">
            {value}
          </s-text>

          <s-text class="sd-summary-card__description">{description}</s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
export default function SyncSummary({ overview, loading }) {
  const sources = overview?.sources || [];
  const automatic = sources.filter(
    (source) => source.syncType === "automatic",
  ).length;
  const periodic = sources.filter(
    (source) => source.syncType === "periodic",
  ).length;
  const healthy =
    sources.length > 0 &&
    sources.every((source) => source.status === "healthy");
  const lastRefreshAt = sources
    .map((source) => source.lastFullSyncAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  const timeZone = overview?.shopTimeZone || "UTC";
  const lastRefresh = lastRefreshAt
    ? formatSyncTime(lastRefreshAt, timeZone)
    : "Never";
  const timezoneLabel = lastRefreshAt
    ? formatTimeZone(timeZone, new Date(lastRefreshAt))
    : formatTimeZone(timeZone);
  return (
    <s-grid
      class="sd-summary"
      aria-label="Synchronization overview"
      gridTemplateColumns="@container (inline-size > 900px) repeat(4, minmax(0, 1fr)), @container (inline-size > 600px) 1fr 1fr, 1fr"
      gap="base"
    >
      <SummaryCard
        icon={"check"}
        tone={healthy ? "green" : "gray"}
        label="Sync health"
        value={
          loading && !sources.length
            ? "Checking..."
            : healthy
              ? "All systems operational"
              : "Needs attention"
        }
        description={`${sources.length} data sources`}
      />

      <SummaryCard
        icon={"refresh"}
        tone="green"
        label="Automatic sources"
        value={automatic}
        description="Keep up to date automatically"
      />

      <SummaryCard
        icon={"clock"}
        tone="blue"
        label="Periodic sources"
        value={periodic}
        description="Sync on a schedule"
      />

      <SummaryCard
        icon={"calendar"}
        tone="gray"
        label="Last refresh (any source)"
        value={lastRefresh}
        description={`Shopify time (${timezoneLabel})`}
      />
    </s-grid>
  );
}
export { SyncSummary };
