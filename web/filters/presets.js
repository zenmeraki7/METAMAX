/**
 * METAMAX — Filter Presets
 *
 * User-facing preset constructors using strictly verified canonical fields
 * and approved operators. No duplicate SQL bindings.
 */

export const FILTER_PRESET_IDS = Object.freeze({
  SPECIFIC_PRODUCTS: "specific_products",
  COMPARE_AT_PRICE_BLANK: "compare_at_price_blank",
  PRICE_LESS_THAN_COMPARE_AT: "price_less_than_compare_at",
  PRICE_EQUAL_TO_COMPARE_AT: "price_equal_to_compare_at",
  PRICE_GREATER_THAN_COMPARE_AT: "price_greater_than_compare_at",
});

export const FILTER_PRESETS = Object.freeze({
  [FILTER_PRESET_IDS.SPECIFIC_PRODUCTS]: Object.freeze({
    id: FILTER_PRESET_IDS.SPECIFIC_PRODUCTS,
    label: "Specific products",
    field: "product.id",
    operator: "in",
    description: "Matches products whose Shopify GIDs belong to the selected list",
    createFilter(productGids) {
      const gids = Array.isArray(productGids) ? productGids : [productGids];
      return Object.freeze({
        version: 1,
        root: Object.freeze({
          kind: "condition",
          field: "product.id",
          operator: "in",
          value: Object.freeze([...gids]),
        }),
      });
    },
  }),

  [FILTER_PRESET_IDS.COMPARE_AT_PRICE_BLANK]: Object.freeze({
    id: FILTER_PRESET_IDS.COMPARE_AT_PRICE_BLANK,
    label: "Compare-at Price is Blank",
    field: "variant.compareAtPrice",
    operator: "is_null",
    description: "Matches products with at least one variant missing a compare-at price",
    createFilter() {
      return Object.freeze({
        version: 1,
        root: Object.freeze({
          kind: "condition",
          field: "variant.compareAtPrice",
          operator: "is_null",
        }),
      });
    },
  }),

  [FILTER_PRESET_IDS.PRICE_LESS_THAN_COMPARE_AT]: Object.freeze({
    id: FILTER_PRESET_IDS.PRICE_LESS_THAN_COMPARE_AT,
    label: "Price < Compare-at Price",
    field: "variant.price",
    operator: "lt",
    description: "Matches products with at least one variant where price is less than compare-at price",
    createFilter() {
      return Object.freeze({
        version: 1,
        root: Object.freeze({
          kind: "condition",
          field: "variant.price",
          operator: "lt",
          value: Object.freeze({
            kind: "field",
            field: "variant.compareAtPrice",
          }),
        }),
      });
    },
  }),

  [FILTER_PRESET_IDS.PRICE_EQUAL_TO_COMPARE_AT]: Object.freeze({
    id: FILTER_PRESET_IDS.PRICE_EQUAL_TO_COMPARE_AT,
    label: "Price = Compare-at Price",
    field: "variant.price",
    operator: "eq",
    description: "Matches products with at least one variant where price equals compare-at price",
    createFilter() {
      return Object.freeze({
        version: 1,
        root: Object.freeze({
          kind: "condition",
          field: "variant.price",
          operator: "eq",
          value: Object.freeze({
            kind: "field",
            field: "variant.compareAtPrice",
          }),
        }),
      });
    },
  }),

  [FILTER_PRESET_IDS.PRICE_GREATER_THAN_COMPARE_AT]: Object.freeze({
    id: FILTER_PRESET_IDS.PRICE_GREATER_THAN_COMPARE_AT,
    label: "Price > Compare-at Price",
    field: "variant.price",
    operator: "gt",
    description: "Matches products with at least one variant where price is greater than compare-at price",
    createFilter() {
      return Object.freeze({
        version: 1,
        root: Object.freeze({
          kind: "condition",
          field: "variant.price",
          operator: "gt",
          value: Object.freeze({
            kind: "field",
            field: "variant.compareAtPrice",
          }),
        }),
      });
    },
  }),
});

