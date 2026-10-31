import { useMemo, useState } from "react";
import SyncNotice from "../components/settings/SyncNotice.jsx";
import SyncSummary from "../components/settings/SyncSummary.jsx";
import SyncSourcesTable from "../components/settings/SyncSourcesTable.jsx";
import useShopifyData from "../hooks/useShopifyData.js";
import useShopifyToast from "../hooks/useShopifyToast.js";
export default function ShopifyDataPage() {
  const { notify } = useShopifyToast();
  const sync = useShopifyData(notify);
  const [search, setSearch] = useState("");
  const [showNotice, setShowNotice] = useState(true);
  const filteredSources = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) {
      return sync.overview.sources;
    }
    return sync.overview.sources.filter((source) =>
      source.name.toLocaleLowerCase().includes(query),
    );
  }, [search, sync.overview.sources]);
  const handleReload = () => {
    if (sync.isDemo) {
      notify?.("Demo mode: showing example sync data.");
      return;
    }
    void sync.reload();
  };
  return (
    <s-page heading="Shopify data">
      <s-button slot="secondary-actions" icon="refresh" onClick={handleReload}>
        Reload sync status
      </s-button>
      <s-link slot="breadcrumb-actions" href="/settings">
        Settings
      </s-link>
      <s-stack gap="base">
        <s-stack class="sd-content" gap="base">
          <s-section>
            <s-stack gap="base">
              {sync.isDemo && (
                <s-stack class="sd-demo-note" gap="base">
                  Demo data — refresh actions do not trigger a real Shopify
                  sync.
                </s-stack>
              )}

              {showNotice && (
                <SyncNotice onDismiss={() => setShowNotice(false)} />
              )}

              {sync.error && (
                <s-stack class="sd-error" role="alert" gap="base">
                  Unable to retrieve live sync status: {sync.error}
                </s-stack>
              )}

              <SyncSummary overview={sync.overview} loading={sync.loading} />
            </s-stack>
          </s-section>

          <s-section heading="Data sources">
            <s-stack gap="base">
              <SyncSourcesTable
                sources={filteredSources}
                totalCount={sync.overview.sources.length}
                timeZone={sync.overview.shopTimeZone}
                search={search}
                onSearchChange={setSearch}
                loading={sync.loading}
                busyKeys={sync.busyKeys}
                onRefreshSource={sync.refreshSource}
                onRefreshAll={sync.refreshAll}
              />
            </s-stack>
          </s-section>
        </s-stack>
      </s-stack>
    </s-page>
  );
}
export { ShopifyDataPage };
