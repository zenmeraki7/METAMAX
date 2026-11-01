
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

const EMPTY_VALUE = "—";

const METRICS = Object.freeze([
  {
    key: "productCount",
    label: "Total products",
    icon: "product",
  },
  {
    key: "variantCount",
    label: "Total variants",
    icon: "variant",
  },
  {
    key: "activeCount",
    label: "Active products",
    icon: "check-circle",
  },
]);

function formatCount(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return EMPTY_VALUE;
  }

  if (
    typeof value === "string" &&
    !/^\d+$/.test(value.trim())
  ) {
    return EMPTY_VALUE;
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    return EMPTY_VALUE;
  }

  return NUMBER_FORMATTER.format(number);
}

export default function ProductsInsights({ summary }) {
  return (
    <s-section padding="none" accessibilityLabel="Catalog overview">
      <div className="products-summary">
        {METRICS.map(({ key, label, icon }) => (
          <div className="products-summary__metric" key={key}>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-icon type={icon} tone={key === "activeCount" ? "success" : "auto"} />
              <s-text color="subdued">{label}</s-text>
            </s-stack>
            <strong className="products-summary__value" aria-label={summary ? undefined : `${label} available after sync`}>{formatCount(summary?.[key])}</strong>
          </div>
        ))}
      </div>
    </s-section>
  );
}

export { ProductsInsights };
