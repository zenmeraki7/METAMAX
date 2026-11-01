/** Transaction effects, distinct from Shopify field read/write permissions.
 * Export admission/leases and preview preparation persist durable state. */
export const TENANT_OPERATIONS=Object.freeze([
  ...['audit','sync_sources.read'].map(operation=>Object.freeze({operation,mode:'READ'})),
  // Catalog/filter preparation extends generation retain_until. Their SQL
  // selection statements are read-only, but the complete operation is WRITE.
  ...['filter','catalog','export','preview','import','bulk_edit','scheduled_edit','recurring_edit','undo','mutation']
    .map(operation=>Object.freeze({operation,mode:'WRITE'})),
]);

// Worker policies must be installed by composition with the actual repository
// namespace and durable job kind. There is deliberately no wildcard grant.
export const TENANT_WORKER_POLICIES=Object.freeze([]);
