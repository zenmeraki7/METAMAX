export const INVENTORY_PAGE_SIZE = 100;

export const INVENTORY_QUANTITY_NAMES = Object.freeze([
  "available",
  "on_hand",
  "committed",
  "reserved",
  "incoming",
  "damaged",
  "safety_stock",
  "quality_control",
]);

export const GET_INVENTORY_ITEM = `
  query GetInventoryItem(
    $id: ID!
    $after: String
  ) {
    inventoryItem(id: $id) {
      id
      sku
      tracked
      requiresShipping
      updatedAt

      inventoryLevels(
        first: ${INVENTORY_PAGE_SIZE}
        after: $after
        includeInactive: true
      ) {
        edges {
          node {
            # Preserve the complete opaque GID, including query parameters.
            id
            isActive
            updatedAt

            location {
              id
              name
              isActive
              fulfillsOnlineOrders
              updatedAt
            }

            quantities(
              names: [
                ${INVENTORY_QUANTITY_NAMES.map((name) =>
                  JSON.stringify(name)
                ).join("\n                ")}
              ]
            ) {
              name
              quantity
              updatedAt
            }
          }
        }

        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const GET_INVENTORY_ITEM_VERSION = `
  query GetInventoryItemVersion($id: ID!) {
    inventoryItem(id: $id) {
      id
      updatedAt
    }
  }
`;
