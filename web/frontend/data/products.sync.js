const stages = {
  NOT_STARTED: "Preparing your catalog import.",
  PENDING: "Your catalog import is queued.",
  STARTING: "Starting your catalog export from Shopify.",
  WAITING: "Shopify is preparing your catalog export.",
  INGESTING: "Importing your products from Shopify.",
  RECONCILING: "Applying changes received during import before your catalog is ready.",
};

export function catalogNotice(status, hasCatalog) {
  if (!status) return null;
  if (status === "FAILED")
    return {
      failed: true,
      message: `Catalog sync needs attention. ${
        hasCatalog
          ? "Your last published catalog is shown below."
          : "Your products will appear after the import recovers."
      }`,
    };
  if (status === "READY" && hasCatalog)
    return {
      failed: false,
      message: "Catalog ready. Product and inventory changes sync automatically from Shopify.",
    };
  return {
    failed: false,
    message: `${stages[status] ?? "Syncing your catalog from Shopify."} ${
      hasCatalog
        ? "Your last published catalog is available below."
        : "Your products will appear here automatically when ready."
    }`,
  };
}
