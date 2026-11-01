import { useCallback, useId, useMemo } from "react";

import ProductRow from "./ProductRow.jsx";
import { productColumns } from "../../data/products.columns.js";

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

const NUMERIC_COLUMNS = new Set(["variants"]);

const COLUMN_LIST_SLOTS = Object.freeze({
  status: "inline",
  inventory: "labeled",
  variants: "labeled",
  productType: "labeled",
  vendor: "labeled",
});

const EMPTY_VALUE = "—";

function formatTotal(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }

  return NUMBER_FORMATTER.format(value);
}

function getColumns(visibleColumns) {
  if (!Array.isArray(visibleColumns)) {
    return [];
  }

  const visible = new Set(visibleColumns);

  return productColumns.filter(({ key }) => visible.has(key));
}

export default function ProductsTable({
  products = [],
  visibleColumns = [],
  selection,
  density,
  loading = false,
  error = null,
  emptyMessage = "No products found.",
  page = 1,
  total,
  hasPreviousPage = false,
  hasNextPage = false,
  onPrevious,
  onNext,
}) {
  const tableId = useId();

  const columns = useMemo(() => getColumns(visibleColumns), [visibleColumns]);

  const isLoading = Boolean(loading);
  const hasError = Boolean(error);

  const visibleProducts = !hasError && Array.isArray(products) ? products : [];

  const hasProducts = visibleProducts.length > 0;

  const selectedIds =
    selection?.selectedIds instanceof Set ? selection.selectedIds : null;

  const canSelectOne =
    !isLoading &&
    !hasError &&
    selectedIds !== null &&
    typeof selection?.setOneSelected === "function";

  const canSelectAll =
    hasProducts &&
    canSelectOne &&
    typeof selection?.setAllVisibleSelected === "function";

  const allVisibleSelected =
    canSelectAll && Boolean(selection.allVisibleSelected);

  const partiallySelected =
    canSelectAll && Boolean(selection.partiallySelected);

  const pageNumber = Number.isSafeInteger(page) && page > 0 ? page : 1;

  const formattedTotal = formatTotal(total);

  const canGoPrevious =
    !isLoading &&
    !hasError &&
    Boolean(hasPreviousPage) &&
    typeof onPrevious === "function";

  const canGoNext =
    !isLoading &&
    !hasError &&
    Boolean(hasNextPage) &&
    typeof onNext === "function";

  const paginationEnabled =
    !hasError &&
    (Boolean(hasPreviousPage) || Boolean(hasNextPage) || pageNumber > 1);

  const showTable = !hasError && (hasProducts || !isLoading);

  const showLoading = !hasError && !hasProducts && isLoading;

  const showEmpty = !hasError && !hasProducts && !isLoading;

  function handleSelectAll(event) {
    if (!canSelectAll) {
      return;
    }

    selection.setAllVisibleSelected(Boolean(event.currentTarget.checked));
  }

  const selectOne = selection?.setOneSelected;
  const handleSelectProduct = useCallback(
    (id, checked) => {
      if (!canSelectOne) {
        return;
      }

      selectOne(id, checked);
    },
    [canSelectOne, selectOne],
  );

  function handlePreviousPage() {
    if (canGoPrevious) {
      onPrevious();
    }
  }

  function handleNextPage() {
    if (canGoNext) {
      onNext();
    }
  }

  const countLabel =
    formattedTotal === null
      ? `Page ${pageNumber}`
      : `${formattedTotal} matching products · Page ${pageNumber}`;

  return (
    <s-section padding="none" accessibilityLabel="Product catalog">
      <s-stack gap="none">
        {showTable && (
          <s-table
            variant="auto"
            loading={isLoading}
            paginate={paginationEnabled}
            hasPreviousPage={canGoPrevious}
            hasNextPage={canGoNext}
            onpreviouspage={handlePreviousPage}
            onnextpage={handleNextPage}
          >
            <s-table-header-row>
              <s-table-header listSlot="primary">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-checkbox
                    accessibilityLabel="Select all visible products"
                    checked={allVisibleSelected}
                    indeterminate={partiallySelected}
                    disabled={!canSelectAll}
                    onChange={handleSelectAll}
                  />

                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: "40px",
                      flexShrink: 0,
                    }}
                  />

                  <s-text>Product</s-text>
                </s-stack>
              </s-table-header>

              {columns.map(({ key, label }) => (
                <s-table-header
                  key={key}
                  listSlot={COLUMN_LIST_SLOTS[key] ?? "labeled"}
                  format={NUMERIC_COLUMNS.has(key) ? "numeric" : "base"}
                >
                  {label}
                </s-table-header>
              ))}
            </s-table-header-row>

            <s-table-body>
              {visibleProducts.map((product, index) => (
                <ProductRow
                  key={product.id}
                  product={product}
                  columns={columns}
                  selected={selectedIds?.has(product.id) ?? false}
                  onSelect={handleSelectProduct}
                  checkboxId={`${tableId}-product-${index}`}
                  disabled={!canSelectOne}
                  density={density}
                />
              ))}
            </s-table-body>
          </s-table>
        )}

        {hasError && (
          <s-box padding="base">
            <s-banner tone="critical" heading="Unable to load products">
              {typeof error === "string" && error.trim()
                ? error
                : "Something went wrong while loading the catalog."}
            </s-banner>
          </s-box>
        )}

        {showLoading && (
          <s-box padding="base">
            <s-stack gap="base">
              <s-stack direction="inline" gap="small" alignItems="center">
              <s-spinner accessibilityLabel="Loading products" />
                <s-text color="subdued">Loading products…</s-text>
              </s-stack>
              <div className="products-skeleton" aria-hidden="true">
                {[0, 1, 2, 3].map(row => <div className="products-skeleton__row" key={row}><span className="products-skeleton__image" /><span className="products-skeleton__title" /><span /><span /></div>)}
              </div>
            </s-stack>
          </s-box>
        )}

        {showEmpty && (
          <s-box padding="large">
            <s-stack gap="small" alignItems="center">
              <s-icon type="product" color="subdued" size="large" />
              <s-heading>Your catalog starts here</s-heading>
              <s-text color="subdued">{emptyMessage}</s-text>
            </s-stack>
          </s-box>
        )}

        {!hasError && (
          <s-box padding="base">
            <s-text color="subdued">
              {countLabel}
              {isLoading && hasProducts ? " · Updating…" : ""}
            </s-text>
          </s-box>
        )}
      </s-stack>
    </s-section>
  );
}

export { ProductsTable };
