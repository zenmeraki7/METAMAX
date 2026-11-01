import { useEffect, useRef, useState } from "react";
import HistoryTabs from "../components/history/HistoryTabs.jsx";
import HistoryFilters from "../components/history/HistoryFilters.jsx";
import HistoryStats from "../components/history/HistoryStats.jsx";
import HistoryTable from "../components/history/HistoryTable.jsx";
import HistoryDetailDialog from "../components/history/HistoryDetailDialog.jsx";
import useHistoryFilters from "../hooks/useHistoryFilters.js";
import useHistoryPagination from "../hooks/useHistoryPagination.js";
import useHistorySelection from "../hooks/useHistorySelection.js";
import useHistoryOperations from "../hooks/useHistoryOperations.js";
import useShopifyToast from "../hooks/useShopifyToast.js";
import { downloadHistoryCsv } from "../utils/historyCsv.js";
import { routes } from "../config/routes.js";
export default function HistoryPage() {
  const { operations, isDemo, loading, loadingMore, hasNextPage, loadMore, error, refetch } = useHistoryOperations();
  const filters = useHistoryFilters(operations);
  const pagination = useHistoryPagination(filters.filtered);
  const selection = useHistorySelection(pagination.pageRecords);
  const { notify } = useShopifyToast();
  const [selectedOperation, setSelectedOperation] = useState(null);
  const helpDialogRef = useRef(null);
  const { clearSelection } = selection;

  // Selections are scoped to the current query.
  useEffect(() => {
    clearSelection();
  }, [filters.filtered, clearSelection]);
  const handleCopy = async (id) => {
    try {
      await navigator.clipboard.writeText(id);
      notify("Operation ID copied.");
    } catch {
      notify(`Operation ID: ${id}`);
    }
  };
  const handleRetry = (operation) => {
    notify(isDemo ? `Demo mode: ${operation.title} was not retried.` : "Retry is not available from history yet.");
  };
  const handleExport = () => {
    downloadHistoryCsv(filters.filtered);
    notify(isDemo ? "Demo history CSV downloaded." : "Loaded filtered history CSV downloaded.");
  };
  const handleHelp = () => {
    helpDialogRef.current?.showOverlay();
  };
  return (
    <s-page heading="History">
      {isDemo ? <s-banner tone="info">Demo mode: this history contains example operations.</s-banner>
        : error ? <s-banner tone="critical">{error}<s-button onClick={refetch}>Try again</s-button></s-banner>
        : loading ? <s-banner tone="info">Loading operation history…</s-banner>
        : <s-banner tone="success">Connected to live operation history.</s-banner>}
      <s-button slot="primary-action" variant="primary" href={routes.bulkEdit}>
        New edit
      </s-button>
      <s-button slot="secondary-actions" icon="download" onClick={handleExport} disabled={loading || Boolean(error) || !filters.filtered.length}>
        Export loaded filtered history
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        onClick={handleHelp}
      >
        How history works
      </s-button>
      <s-link slot="breadcrumb-actions" href={routes.home}>
        Home
      </s-link>

      <s-stack gap="base">
        <s-stack class="mh-content" gap="base">
          <s-paragraph color="subdued">
            View and manage all your bulk edits, exports, imports and file
            operations.
          </s-paragraph>

          <HistoryTabs active={filters.tab} onChange={filters.setTab} />

          <HistoryFilters filters={filters} />

          <HistoryStats operations={operations} />

          {selection.selectedCount > 0 && (
            <s-stack
              class="mh-selection-bar"
              direction="inline"
              gap="base"
              alignItems="center"
            >
              <s-text type="strong">{selection.selectedCount} selected</s-text>

              <s-button
                onClick={() => {
                  const records = filters.filtered.filter((item) =>
                    selection.selectedIds.has(item.id),
                  );
                  downloadHistoryCsv(records, "metamax-selected-history.csv");
                }}
              >
                Export selected CSV
              </s-button>

              <s-button variant="tertiary" onClick={selection.clearSelection}>
                Clear selection
              </s-button>
            </s-stack>
          )}

          <HistoryTable
            pagination={pagination}
            selection={selection}
            sortDirection={filters.sortDirection}
            onSort={filters.toggleSort}
            onView={setSelectedOperation}
            onCopy={handleCopy}
            onRetry={handleRetry}
          />
          <s-text color="subdued">Search, statistics and exports cover {operations.length} loaded operations.</s-text>
          {hasNextPage && <s-button onClick={loadMore} disabled={loading || loadingMore} loading={loadingMore}>Load older operations</s-button>}
        </s-stack>

        <HistoryDetailDialog
          operation={selectedOperation}
          isDemo={isDemo}
          onClose={() => setSelectedOperation(null)}
        />

        <s-modal
          ref={helpDialogRef}
          id="history-help"
          heading="How history works"
        >
          <s-paragraph>
            History records operations performed by METAMAX, including bulk
            edits, imports, exports, and file jobs.
          </s-paragraph>

          <s-paragraph>
            You can search operations, filter them by status or type, inspect
            processing progress, and review execution details.
          </s-paragraph>

          <s-paragraph>
            Statistics and CSV exports use the loaded history records. Use the
            filters to narrow the records included in an export.
          </s-paragraph>

          <s-button
            slot="secondary-actions"
            commandFor="history-help"
            command="--hide"
          >
            Got it
          </s-button>
        </s-modal>
      </s-stack>
    </s-page>
  );
}
