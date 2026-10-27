function StatCard({ title, value, detail, tone, icon: Icon, growth = false }) {
  return (
    <s-section class="mh-stat">
      <s-stack gap="base">
        <s-stack
          class={`mh-stat__icon mh-tone--${tone}`}
          aria-hidden="true"
          direction="inline"
          gap="small"
          alignItems="center"
        >
          <s-icon type={Icon} />
        </s-stack>

        <s-stack class="mh-stat__content" gap="base">
          <s-text class="mh-stat__title">{title}</s-text>

          <s-stack class="mh-stat__numbers" direction="inline" gap="base">
            <s-text type="strong">{value}</s-text>

            <s-text class={growth ? "mh-stat__growth" : "mh-stat__detail"}>
              {growth && <s-icon type="arrow-up" />}

              {detail}
            </s-text>
          </s-stack>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
export default function HistoryStats({ operations }) {
  const total = operations.length;
  const count = (status) =>
    operations.filter((item) => item.status === status).length;
  const completed = count("Completed");
  const cancelled = count("Cancelled");
  const failed = count("Failed");
  const percentage = (value) => (total ? Math.round((value / total) * 100) : 0);
  return (
    <s-grid
      class="mh-stats"
      aria-label="History statistics"
      gridTemplateColumns="@container (inline-size > 900px) repeat(4, minmax(0, 1fr)), @container (inline-size > 600px) 1fr 1fr, 1fr"
      gap="base"
    >
      <StatCard
        title="Total operations"
        value={total}
        detail="12% from last 30 days"
        tone="blue"
        icon={"clipboard"}
        growth
      />

      <StatCard
        title="Completed"
        value={completed}
        detail={`${percentage(completed)}% success rate`}
        tone="green"
        icon={"check"}
      />

      <StatCard
        title="Cancelled"
        value={cancelled}
        detail={`${percentage(cancelled)}% of operations`}
        tone="gray"
        icon={"x-circle"}
      />

      <StatCard
        title="Failed"
        value={failed}
        detail={`${percentage(failed)}% of operations`}
        tone="red"
        icon={"alert-triangle"}
      />
    </s-grid>
  );
}
