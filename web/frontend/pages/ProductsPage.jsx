import { useCallback, useEffect, useRef, useState } from "react";
import {useSharedSyncProgress,canEditCatalog} from "../hooks/SyncProgressContext.js";
import {syncActive} from "../hooks/useSyncProgress.js";
import useProductCapabilities from '../hooks/useProductCapabilities.js';
import { useSearchParams } from "react-router-dom";
import ProductsInsights from "../components/products/ProductsInsights.jsx";
import ProductsToolbar from "../components/products/ProductsToolbar.jsx";
import ProductsTable from "../components/products/ProductsTable.jsx";
import ProductsSyncProgress from "../components/products/ProductsSyncProgress.jsx";
import useProductCatalog from "../hooks/useProductCatalog.js";
import useProductSelection from "../hooks/useProductSelection.js";
import { productColumns } from "../data/products.columns.js";
import { catalogNotice } from "../data/products.sync.js";
import "../styles/products.css";
const EMPTY_PRODUCTS = [];
export default function ProductsPage() {
  const [params] = useSearchParams();
  const catalog = useProductCatalog(params.get("search") ?? "");
  const {job:syncJob,error:syncError} = useSharedSyncProgress();
  const editingAllowed = canEditCatalog({job:syncJob,error:syncError});
  const catalogEditable = editingAllowed && catalog.data?.snapshotId === syncJob?.generationId;
  const preview = !editingAllowed && syncJob?.generationId && syncJob.previewProducts?.length > 0;
  const observedSync = useRef(null);
  useEffect(() => {
    if (!syncJob) return;
    if (syncActive(syncJob)) observedSync.current = syncJob.id;
    else if (syncJob.id && observedSync.current === syncJob.id && syncJob.status === "SUCCEEDED" && syncJob.progress.percent === 100) {
      observedSync.current = null;
      catalog.reload();
    }
  }, [syncJob, catalog.reload]);
  const capabilities=useProductCapabilities(catalog.data?.snapshotId,catalog.data?.publishedRevision,catalog.error);
  const products = preview ? syncJob.previewProducts : catalog.data?.products ?? EMPTY_PRODUCTS;
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
      editingAllowed,
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
          : "Synced products will appear here as they are saved. Editing unlocks after sync completes."
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
        disabled={!editingAllowed}
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
      <s-stack gap="small">
        <ProductsInsights summary={hasCatalog ? catalog.data.summary : null} />
        <ProductsSyncProgress />
        {catalog.error && !preview && (
          <s-banner heading="We couldn’t load your products" tone="critical" role="alert">
            <s-text>{catalog.error}</s-text>
            <s-button onClick={catalog.reload} disabled={catalog.loading}>
              Try again
            </s-button>
          </s-banner>
        )}
        {!editingAllowed && (
          <s-text color="subdued">Editing is locked until catalog sync completes.{preview ? " Live preview: first 50 saved products. Filters, selection and editing unlock after verification." : ""}</s-text>
        )}
        {notice && !preview && (
          <s-banner heading={notice.failed ? "Catalog needs attention" : "Getting your catalog ready"} tone={notice.failed ? "warning" : "info"}>
            {notice.message}
          </s-banner>
        )}
        {!preview && <ProductsToolbar
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
          selectedCount={catalogEditable ? selection.selectedCount : 0}
          clearSelection={selection.clearSelection}
          allVisibleSelected={selection.allVisibleSelected}
          setAllVisibleSelected={selection.setAllVisibleSelected}
          hasProducts={catalogEditable && products.length > 0}
        />}
        {catalog.autoRefreshAvailable === false && (
          <s-text color="subdued">
            Automatic updates are unavailable. Use Refresh to check for changes.
          </s-text>
        )}
        <ProductsTable
          products={products}
          visibleColumns={preview ? ['status','productType','vendor'] : visibleColumns}
          selection={selection}
          density={density}
          loading={!preview && catalog.loading}
          readOnly={!catalogEditable}
          emptyMessage={emptyMessage}
          page={preview ? 1 : catalog.page}
          total={preview ? undefined : catalog.data?.filteredCount}
          hasPreviousPage={!preview && catalog.hasPreviousPage}
          hasNextPage={!preview && (catalog.data?.pageInfo.hasNextPage ?? false)}
          onPrevious={catalog.previousPage}
          onNext={catalog.nextPage}
        />
      </s-stack>
    </s-page>
  );
}
export { ProductsPage };
