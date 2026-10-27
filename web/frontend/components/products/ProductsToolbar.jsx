import { productColumns } from "../../data/products.columns.js";
const statuses = ["All", "Active", "Draft", "Archived", "Unlisted"];
export default function ProductsToolbar({
  search,
  setSearch,
  status,
  setStatus,
  visibleColumns,
  toggleColumn,
  selectedCount = 0,
  clearSelection,
  allVisibleSelected = false,
  setAllVisibleSelected,
  hasProducts = false,
}) {
  const hasStatusFilter = status !== "ALL";

  return (
    <s-section accessibilityLabel="Product filters">
      <s-stack gap="base">
        {selectedCount > 0 ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text type="strong">{selectedCount} selected</s-text>
            {typeof setAllVisibleSelected === "function" && (
              <s-button
                onClick={() => setAllVisibleSelected(!allVisibleSelected)}
              >
                {allVisibleSelected ? "Unselect visible" : "Select all visible"}
              </s-button>
            )}
            <s-button onClick={clearSelection}>Deselect all</s-button>
          </s-stack>
        ) : (
          <s-grid
            gridTemplateColumns="@container (inline-size > 600px) 1fr auto auto auto, 1fr"
            gap="base"
            alignItems="end"
          >
            <s-search-field
              label="Search products"
              value={search}
              placeholder="Search title, vendor, type or handle"
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
            {hasProducts && typeof setAllVisibleSelected === "function" && (
              <s-button
                icon="check-circle"
                onClick={() => setAllVisibleSelected(true)}
              >
                Select all
              </s-button>
            )}
            <s-button
              icon={hasStatusFilter ? "filter-active" : "filter"}
              commandFor="product-filters"
              accessibilityLabel={
                hasStatusFilter
                  ? "Filter products, 1 active filter"
                  : "Filter products"
              }
            >
              {hasStatusFilter ? "Filters (1)" : "Filters"}
            </s-button>
            <s-button icon="layout-columns-3" commandFor="product-columns">
              Columns
            </s-button>
          </s-grid>
        )}
        <s-popover id="product-filters" inlineSize="280px">
          <s-box padding="base">
            <s-stack gap="base">
              <s-heading>Filter products</s-heading>
              <s-select
                label="Product status"
                value={status}
                onChange={(event) => setStatus(event.currentTarget.value)}
              >
                {statuses.map((label) => (
                  <s-option key={label} value={label.toUpperCase()}>
                    {label}
                  </s-option>
                ))}
              </s-select>
              <s-stack direction="inline" gap="small">
                <s-button
                  disabled={!hasStatusFilter}
                  onClick={() => setStatus("ALL")}
                >
                  Clear filter
                </s-button>
                <s-button
                  variant="primary"
                  commandFor="product-filters"
                  command="--hide"
                >
                  Done
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        </s-popover>
        <s-popover id="product-columns">
          <s-box padding="base">
            <s-stack gap="base">
              <s-heading>Columns</s-heading>
              {productColumns.map(({ key, label }) => (
                <s-checkbox
                  key={key}
                  label={label}
                  checked={visibleColumns.includes(key)}
                  onChange={() => toggleColumn(key)}
                />
              ))}
            </s-stack>
          </s-box>
        </s-popover>
      </s-stack>
    </s-section>
  );
}
export { ProductsToolbar };
