import { useEffect, useRef, useState } from "react";
import HistoryTabs from "../components/history/HistoryTabs.jsx";
import HistoryFilters from "../components/history/HistoryFilters.jsx";
import HistoryStats from "../components/history/HistoryStats.jsx";
import HistoryTable from "../components/history/HistoryTable.jsx";
import HistoryDetailDialog from "../components/history/HistoryDetailDialog.jsx";
import useHistoryFilters from "../hooks/useHistoryFilters.js";
import useHistoryPagination from "../hooks/useHistoryPagination.js";
import useHistorySelection from "../hooks/useHistorySelection.js";
import useShopifyToast from "../hooks/useShopifyToast.js";
import { demoHistory } from "../data/history.demo.js";
import { downloadHistoryCsv } from "../utils/historyCsv.js";
import { routes } from "../config/routes.js";
export default function HistoryPage() {
  const filters = useHistoryFilters(demoHistory);
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
    notify(`Demo mode: ${operation.title} was not retried.`);
  };
  const handleExport = () => {
    downloadHistoryCsv(filters.filtered);
    notify("Demo history CSV downloaded.");
  };
  const handleHelp = () => {
    helpDialogRef.current?.showOverlay();
  };
  return (
    <s-page heading="History">
      <s-banner tone="info">This history contains example operations.</s-banner>
      <s-button slot="primary-action" variant="primary" href={routes.bulkEdit}>
        New edit
      </s-button>
      <s-button slot="secondary-actions" icon="download" onClick={handleExport}>
        Export filtered history
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

          <HistoryStats operations={demoHistory} />

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
                  const records = demoHistory.filter((item) =>
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
        </s-stack>

        <HistoryDetailDialog
          operation={selectedOperation}
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
            This demonstration uses local records. Production history should
            come from the backend's persistent job history.
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
