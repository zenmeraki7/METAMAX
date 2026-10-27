import SyncSourceRow from "./SyncSourceRow.jsx";
export default function SyncSourcesTable({
  sources,
  totalCount,
  timeZone,
  search,
  onSearchChange,
  loading,
  busyKeys,
  onRefreshSource,
  onRefreshAll,
}) {
  const refreshingAll = busyKeys.includes("all");
  const anyRefreshing = busyKeys.length > 0;
  return (
    <s-section class="sd-sources-card" aria-labelledby="sd-sources-title">
      <s-stack gap="base">
        <s-stack
          class="sd-sources-header"
          direction="inline"
          gap="base"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-stack gap="base">
            <s-heading id="sd-sources-title">
              Data sources ({totalCount})
            </s-heading>

            <s-paragraph>
              These are the Shopify data types your app syncs and keeps
              available.
            </s-paragraph>
          </s-stack>

          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-search-field
              label="Search data sources"
              placeholder="Search data sources..."
              value={search}
              onInput={(event) => onSearchChange(event.currentTarget.value)}
            />

            <s-button
              onClick={onRefreshAll}
              disabled={anyRefreshing}
              loading={refreshingAll}
            >
              {refreshingAll ? "Requesting..." : "Refresh all"}
            </s-button>
          </s-grid>
        </s-stack>

        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Data source</s-table-header>
            <s-table-header listSlot="secondary">Sync type</s-table-header>
            <s-table-header>Last full sync</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {sources.map((source) => (
              <SyncSourceRow
                key={source.id}
                source={source}
                timeZone={timeZone}
                busy={busyKeys.includes(source.id)}
                disabled={refreshingAll}
                onRefresh={onRefreshSource}
              />
            ))}
          </s-table-body>
        </s-table>

        {loading && !totalCount && (
          <s-stack class="sd-empty" role="status" gap="base">
            Loading data sources...
          </s-stack>
        )}

        {!loading && sources.length === 0 && (
          <s-stack class="sd-empty" gap="base">
            {search
              ? "No data sources match your search."
              : "No data sources available."}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
export { SyncSourcesTable };
