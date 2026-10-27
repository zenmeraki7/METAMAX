export const PRODUCT_VARIANT_PAGE_SIZE = 100;

export const VARIANT_FIELDS = `
  id
  title
  position
  sku
  barcode
  price
  compareAtPrice
  inventoryQuantity
  createdAt
  updatedAt

  inventoryItem {
    id
  }

  selectedOptions {
    name
    value
  }
`;

const VARIANT_CONNECTION = `
  variants(
    first: ${PRODUCT_VARIANT_PAGE_SIZE}
    after: $after
    sortKey: ID
  ) {
    edges {
      node {
        ${VARIANT_FIELDS}
      }
    }

    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

export const PRODUCT_FIELDS = `
      id
      title
      handle
      descriptionHtml
      status
      vendor
      productType
      tags
      totalInventory
      tracksInventory
      createdAt
      updatedAt

      featuredImage {
        url
      }

      options {
        name
        position
        values
      }

      variantsCount {
        count
        precision
      }
`;

export const GET_PRODUCT = `
  query ReconcileProduct(
    $id: ID!
    $after: String
  ) {
    product(id: $id) {
      ${PRODUCT_FIELDS}
      ${VARIANT_CONNECTION}
    }
  }
`;

export const GET_PRODUCT_VARIANTS = `
  query ReconcileProductVariants(
    $id: ID!
    $after: String
  ) {
    product(id: $id) {
      id
      updatedAt

      ${VARIANT_CONNECTION}
    }
  }
`;

export const GET_PRODUCT_VERSION = `
  query ProductVersion($id: ID!) {
    product(id: $id) {
      id
      updatedAt

      variantsCount {
        count
        precision
      }
    }
  }
`;
