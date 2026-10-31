import { demoMetrics } from "../../data/dashboard.demo.js";
import { MetricCard } from "./MetricCard.jsx";

export function MetricsGrid({ metrics = demoMetrics }) {
  return (
    <section aria-label="Performance overview">
      <s-grid
        gridTemplateColumns="@container (inline-size > 600px) 'repeat(3, minmax(0, 1fr))', (inline-size > 960px) 'repeat(5, minmax(0, 1fr))', '1fr'"
        gap="base"
      >
        {metrics.map((metric) => (
          <MetricCard key={metric.id} metric={metric} />
        ))}
      </s-grid>
    </section>
  );
}

export default MetricsGrid;
