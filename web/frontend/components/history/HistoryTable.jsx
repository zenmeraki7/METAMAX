import HistoryRow from "./HistoryRow.jsx";
export default function HistoryTable({
  pagination,
  selection,
  sortDirection,
  onSort,
  onView,
  onCopy,
  onRetry,
}) {
  const SortIcon = sortDirection === "desc" ? "arrow-down" : "arrow-up";
  return (
    <s-section class="mh-table-card" aria-label="Operation history">
      <s-stack gap="base">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">
              <s-stack gap="base">
                <s-checkbox
                  accessibilityLabel="Select all operations on this page"
                  checked={selection.allSelected}
                  indeterminate={selection.indeterminate}
                  disabled={!pagination.pageRecords.length}
                  onChange={(event) =>
                    selection.selectPage(event.currentTarget.checked)
                  }
                />
                <s-text>Title</s-text>
              </s-stack>
            </s-table-header>

            <s-table-header listSlot="secondary">Type</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Progress</s-table-header>
            <s-table-header>User</s-table-header>

            <s-table-header>
              <s-button
                variant="tertiary"
                onClick={onSort}
                accessibilityLabel="Sort by start time"
                icon={SortIcon}
              >
                Started at
              </s-button>
            </s-table-header>

            <s-table-header>Duration</s-table-header>
            <s-table-header>Actions</s-table-header>
          </s-table-header-row>

          <s-table-body>
            {pagination.pageRecords.map((item) => {
              const checkboxId = `select-op-${item.id}`;
              return (
                <HistoryRow
                  key={item.id}
                  item={item}
                  selected={selection.selectedIds.has(item.id)}
                  onSelect={selection.selectOne}
                  onView={onView}
                  onCopy={onCopy}
                  onRetry={onRetry}
                  checkboxId={checkboxId}
                />
              );
            })}
          </s-table-body>
        </s-table>

        {!pagination.total && (
          <s-stack class="mh-empty" gap="base">
            No operations match the selected filters.
          </s-stack>
        )}

        <s-stack
          class="mh-table-footer"
          direction="inline"
          gap="base"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-text>
            Showing {pagination.from}–{pagination.to} of {pagination.total}{" "}
            results
          </s-text>

          <s-stack
            class="mh-pagination"
            direction="inline"
            gap="base"
            alignItems="center"
          >
            <s-button
              variant="tertiary"
              accessibilityLabel="Previous page"
              disabled={pagination.page === 1}
              onClick={pagination.previous}
              icon="chevron-left"
            ></s-button>

            <s-text>
              Page {pagination.page} of {pagination.pageCount}
            </s-text>

            <s-button
              variant="tertiary"
              accessibilityLabel="Next page"
              disabled={pagination.page === pagination.pageCount}
              onClick={pagination.next}
              icon="chevron-right"
            ></s-button>
          </s-stack>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
export { HistoryTable };
