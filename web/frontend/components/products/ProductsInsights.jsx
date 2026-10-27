
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

const EMPTY_VALUE = "—";

const METRICS = Object.freeze([
  {
    key: "productCount",
    label: "Total products",
  },
  {
    key: "variantCount",
    label: "Total variants",
  },
  {
    key: "activeCount",
    label: "Active products",
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
    <s-query-container>
      <s-grid
        accessibilityLabel="Catalog overview"
        gridTemplateColumns="@container (inline-size > 700px) 1fr 1fr 1fr, @container (inline-size > 420px) 1fr 1fr, 1fr"
        gap="base"
      >
        {METRICS.map(({ key, label }) => (
          <s-grid-item key={key}>
            <s-section heading={label}>
              <s-text
                type="strong"
                fontSize="large-100"
                fontVariantNumeric="tabular-nums"
              >
                {formatCount(summary?.[key])}
              </s-text>
            </s-section>
          </s-grid-item>
        ))}
      </s-grid>
    </s-query-container>
  );
}

export { ProductsInsights };
