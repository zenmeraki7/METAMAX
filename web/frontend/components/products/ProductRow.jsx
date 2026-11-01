import { memo } from "react";
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const PRODUCT_STATUSES = Object.freeze({
  ACTIVE: {
    label: "Active",
    tone: "success",
  },
  DRAFT: {
    label: "Draft",
    tone: "info",
  },
  ARCHIVED: {
    label: "Archived",
    tone: "neutral",
  },
  UNLISTED: { label: "Unlisted", tone: "neutral" },
});

const EMPTY_VALUE = "—";

function parseInteger(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  if (typeof value === "string" && !/^-?\d+$/.test(value.trim())) {
    return null;
  }

  const number = Number(value);

  return Number.isSafeInteger(number) ? number : null;
}

function formatCount(value) {
  const number = parseInteger(value);

  return number === null ? EMPTY_VALUE : NUMBER_FORMATTER.format(number);
}

function getProductAdminUrl(id) {
  if (typeof id !== "string" && typeof id !== "number") {
    return null;
  }

  const value = String(id).trim();

  const match = /^(?:gid:\/\/shopify\/Product\/)?([1-9]\d*)$/.exec(value);

  if (!match) {
    return null;
  }

  return `shopify://admin/products/${match[1]}`;
}

function ProductStatus({ status }) {
  const normalized = String(status ?? "")
    .trim()
    .toUpperCase();

  const config = PRODUCT_STATUSES[normalized];

  if (!config) {
    return <s-badge tone="neutral">Unknown</s-badge>;
  }

  return <s-badge tone={config.tone}>{config.label}</s-badge>;
}

function ProductInventory({ product }) {
  if (product.tracksInventory === false) {
    return <s-text color="subdued">Not tracked</s-text>;
  }

  const quantity = parseInteger(product.totalInventory);

  if (quantity === null) {
    return <s-text color="subdued">Unavailable</s-text>;
  }

  if (quantity < 0) {
    return <s-text tone="critical">{formatCount(quantity)} in stock</s-text>;
  }

  if (quantity === 0) {
    return <s-text tone="critical">Out of stock</s-text>;
  }

  return <s-text>{formatCount(quantity)} in stock</s-text>;
}

function ProductCell({ columnKey, product }) {
  switch (columnKey) {
    case "status":
      return <ProductStatus status={product.status} />;

    case "inventory":
      return <ProductInventory product={product} />;

    case "variants":
      return (
        <s-text fontVariantNumeric="tabular-nums">
          {formatCount(product.variantCount)}
        </s-text>
      );

    case "productType":
      return product.productType || EMPTY_VALUE;

    case "vendor":
      return product.vendor || EMPTY_VALUE;

    default:
      return EMPTY_VALUE;
  }
}

function ProductRow({
  product,
  columns = [],
  selected = false,
  onSelect,
  checkboxId,
  disabled = false,
  readOnly = false,
  density = "comfortable",
}) {
  const productTitle =
    typeof product.title === "string" && product.title.trim()
      ? product.title
      : "Untitled product";

  const productUrl = getProductAdminUrl(product.id);

  function handleSelectionChange(event) {
    onSelect?.(product.id, event.currentTarget.checked);
  }

  return (
    <s-table-row>
      <s-table-cell>
        <s-box paddingBlock={density === "compact" ? "none" : "small"}>
          <s-grid
            gridTemplateColumns="auto auto minmax(0, 1fr)"
            gap="base"
            alignItems="center"
          >
            <s-checkbox
              id={checkboxId}
              accessibilityLabel={`Select ${productTitle}`}
              checked={Boolean(selected)}
              disabled={disabled}
              onChange={handleSelectionChange}
            />

            <s-thumbnail
              src={product.image || undefined}
              alt={product.image ? "" : "No product image"}
              size="small"
              loading="lazy"
            />

            <span className="products-product-cell__title">
              {productUrl && !readOnly ? (
                <s-link href={productUrl} target="_top">
                  {productTitle}
                </s-link>
              ) : (
                <s-text>{productTitle}</s-text>
              )}
            </span>
          </s-grid>
        </s-box>
      </s-table-cell>

      {columns.map(({ key }) => (
        <s-table-cell key={key}>
          <ProductCell columnKey={key} product={product} />
        </s-table-cell>
      ))}
    </s-table-row>
  );
}

const MemoizedProductRow = memo(ProductRow);
export default MemoizedProductRow;
export { MemoizedProductRow as ProductRow };
