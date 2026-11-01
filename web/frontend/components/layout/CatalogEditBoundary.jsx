import {useSharedSyncProgress,canEditCatalog} from '../../hooks/SyncProgressContext.js';

export default function CatalogEditBoundary({children}) {
  const progress=useSharedSyncProgress();
  if(canEditCatalog(progress))return children;
  return <s-page heading="Editing is locked">
    <s-section>
      <s-stack gap="small">
        <s-text>Catalog sync must complete before you can edit products. Saved products are available as a read-only preview.</s-text>
        <s-button href="/products">View sync progress and products</s-button>
      </s-stack>
    </s-section>
  </s-page>;
}
