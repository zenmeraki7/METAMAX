import { useCallback, useEffect, useState } from "react";
import useProductCapabilities from '../hooks/useProductCapabilities.js';
import { useSearchParams } from "react-router-dom";
import ProductsInsights from "../components/products/ProductsInsights.jsx";
import ProductsToolbar from "../components/products/ProductsToolbar.jsx";
import ProductsTable from "../components/products/ProductsTable.jsx";
import useProductCatalog from "../hooks/useProductCatalog.js";
import useProductSelection from "../hooks/useProductSelection.js";
import { productColumns } from "../data/products.columns.js";
import { catalogNotice } from "../data/products.sync.js";
import "../styles/products.css";
const EMPTY_PRODUCTS = [];
export default function ProductsPage() {
  const [params] = useSearchParams();
  const catalog = useProductCatalog(params.get("search") ?? "");
  const capabilities=useProductCapabilities(catalog.data?.snapshotId,catalog.data?.publishedRevision,catalog.error);
  const products = catalog.data?.products ?? EMPTY_PRODUCTS;
  const selection = useProductSelection(products);
  const [density, setDensity] = useState("comfortable");
  const [visibleColumns, setVisibleColumns] = useState(
    productColumns.map(({ key }) => key),
  );
  const toggleColumn = useCallback(
    (key) =>
      setVisibleColumns((current) =>
        current.includes(key)
          ? current.filter((id) => id !== key)
          : [...current, key],
      ),
    [],
  );
  useEffect(
    () => selection.clearSelection(),
    [
      catalog.page,
      catalog.search,
      catalog.status,
      catalog.conditions,
      catalog.match,
      catalog.data?.snapshotId,
      selection.clearSelection,
    ],
  );
  const state = catalog.awaitingInitialSync ? "PENDING" : catalog.data?.syncStatus;
  const hasCatalog = Boolean(catalog.data?.snapshotId);
  const notice = catalogNotice(state, hasCatalog);
  const emptyMessage = catalog.loading
    ? "Loading products…"
    : catalog.error
      ? "Products are unavailable. Try again."
      : !hasCatalog
        ? state === "FAILED"
          ? "The first catalog import needs attention."
          : "Your products will appear when the initial sync finishes."
        : catalog.data.summary.productCount === 0
          ? "No products in your store yet. Add your first product in Shopify."
          : "No products match your search or filters. Try changing your filters.";
  return (
    <s-page heading="Products" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        href="shopify://admin/products/new"
        target="_top"
      >
        Add product
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="refresh"
        onClick={catalog.reload}
        disabled={catalog.loading}
      >
        Refresh
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="menu-horizontal"
        commandFor="products-page-actions"
      >
        More actions
      </s-button>
      <s-menu id="products-page-actions" accessibilityLabel="Product actions">
        <s-button
          onClick={() =>
            setDensity(density === "compact" ? "comfortable" : "compact")
          }
        >
          {density === "compact"
            ? "Use comfortable density"
            : "Use compact density"}
        </s-button>
      </s-menu>
      <s-link slot="breadcrumb-actions" href="/">
        Home
      </s-link>
      <s-stack gap="base">
        {catalog.error && (
          <s-stack
            class="products-notice products-notice--error"
            role="alert"
            gap="base"
          >
            <s-text>{catalog.error}</s-text>
            <s-button onClick={catalog.reload} disabled={catalog.loading}>
              Try again
            </s-button>
          </s-stack>
        )}
        {notice && (
          <s-stack
            class={`products-notice${notice.failed ? " products-notice--error" : ""}`}
            role="status"
            gap="base"
          >
            {notice.message}
          </s-stack>
        )}
        <ProductsInsights summary={hasCatalog ? catalog.data.summary : null} />
        <ProductsToolbar
          capabilities={capabilities}
          search={catalog.search}
          setSearch={catalog.setSearch}
          status={catalog.status}
          setStatus={catalog.setStatus}
          conditions={catalog.conditions}
          match={catalog.match}
          setAdvancedFilters={catalog.setAdvancedFilters}
          visibleColumns={visibleColumns}
          toggleColumn={toggleColumn}
          selectedCount={selection.selectedCount}
          clearSelection={selection.clearSelection}
          allVisibleSelected={selection.allVisibleSelected}
          setAllVisibleSelected={selection.setAllVisibleSelected}
          hasProducts={products.length > 0}
        />
        {catalog.autoRefreshAvailable === false && (
          <s-text color="subdued">
            Automatic updates are unavailable. Use Refresh to check for changes.
          </s-text>
        )}
        <ProductsTable
          products={products}
          visibleColumns={visibleColumns}
          selection={selection}
          density={density}
          loading={catalog.loading}
          emptyMessage={emptyMessage}
          page={catalog.page}
          total={catalog.data?.filteredCount}
          hasPreviousPage={catalog.hasPreviousPage}
          hasNextPage={catalog.data?.pageInfo.hasNextPage ?? false}
          onPrevious={catalog.previousPage}
          onNext={catalog.nextPage}
        />
      </s-stack>
    </s-page>
  );
}
export { ProductsPage };
