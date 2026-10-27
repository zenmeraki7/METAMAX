export const GET_UPDATED_PRODUCTS = `
  query RepairProducts(
    $filter: String!
    $after: String
  ) {
    resources: products(
      first: 100
      after: $after
      query: $filter
      sortKey: UPDATED_AT
    ) {
      edges {
        node {
          id
          updatedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const GET_UPDATED_VARIANTS = `
  query RepairVariants(
    $filter: String!
    $after: String
  ) {
    resources: productVariants(
      first: 100
      after: $after
      query: $filter
      sortKey: ID
    ) {
      edges {
        node {
          id
          updatedAt
          product {
            id
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const GET_UPDATED_INVENTORY_ITEMS = `
  query RepairInventoryItems($filter: String!, $after: String) {
    resources: inventoryItems(first: 100, after: $after, query: $filter) {
      edges { node { id updatedAt } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
