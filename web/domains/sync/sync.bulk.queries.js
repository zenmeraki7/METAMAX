import {
  PRODUCT_FIELDS,
  VARIANT_FIELDS,
} from "../products/products.queries.js";
import { INVENTORY_QUANTITY_NAMES } from "../inventory/inventory.queries.js";

export function exportQuery(run, name = run.exportName) {
  const operation = `Snapshot_${run.id.replace(/[^a-zA-Z0-9_]/g, "_")}_${name}`;
  const selections = {
    products: `products { edges { node { ${PRODUCT_FIELDS}
      variants { edges { node { ${VARIANT_FIELDS} } } }
    } } }`,
    inventory_items: `inventoryItems { edges { node {
      id sku tracked requiresShipping updatedAt
      inventoryLevels(includeInactive: true) { edges { node {
        id isActive updatedAt
        location { id name isActive fulfillsOnlineOrders updatedAt }
        quantities(names: ${JSON.stringify(
          INVENTORY_QUANTITY_NAMES
        )}) { name quantity updatedAt }
      } } }
    } } }`,
    inventory_locations: `locations(includeInactive: true, includeLegacy: true) { edges { node {
      id name isActive fulfillsOnlineOrders updatedAt
    } } }`,
  };
  if (!selections[name]) throw new TypeError("Unknown export dataset");
  return `query ${operation} { ${selections[name]} }`;
}

export const START_EXPORT = `mutation StartCatalogExport($query: String!) {
  bulkOperationRunQuery(query: $query, groupObjects: true) {
    bulkOperation { id }
    userErrors { field message }
  }
}`;
export const FIND_EXPORT = `query FindCatalogExport($after: String, $filter: String!) {
  bulkOperations(first: 100, after: $after, query: $filter) {
    nodes { id query }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const READ_EXPORT = `query ReadCatalogExport($id: ID!) {
  bulkOperation(id: $id) { id status errorCode objectCount rootObjectCount url }
}`;
