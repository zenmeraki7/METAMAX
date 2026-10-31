export default function MetricCard({ metric }) {
  return (
    <s-box border="base" borderRadius="base" padding="base" background="base">
      <s-grid
        gridTemplateColumns="auto minmax(0, 1fr)"
        gap="base"
        alignItems="center"
      >
        <s-box padding="small" background="subdued" borderRadius="base">
          <s-icon type={metric.icon || "chart-vertical"} />
        </s-box>
        <s-stack gap="small">
          <s-text color="subdued">{metric.label}</s-text>
          <s-heading>{metric.value}</s-heading>
          <s-text color="subdued">{metric.subtext}</s-text>
        </s-stack>
      </s-grid>
    </s-box>
  );
}
export { MetricCard };
