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
  const inProgress =
    count("Running") + count("In Progress") + count("Queued") + count("Pending") + count("Retrying");
  const cancelled = count("Cancelled");
  const failed = count("Failed") + count("Expired");
  const percentage = (value) => (total ? Math.round((value / total) * 100) : 0);
  return (
    <s-grid
      class="mh-stats"
      aria-label="History statistics"
      gridTemplateColumns="@container (inline-size > 600px) '1fr 1fr', (inline-size > 900px) 'repeat(4, minmax(0, 1fr))', '1fr'"
      gap="base"
    >
      <StatCard
        title="Total operations"
        value={total}
        detail="Loaded history records"
        tone="blue"
        icon={"clipboard"}
      />

      <StatCard
        title="Completed"
        value={completed}
        detail={`${percentage(completed)}% success rate`}
        tone="green"
        icon={"check"}
      />

      <StatCard
        title={inProgress > 0 ? "Active / In progress" : "Cancelled"}
        value={inProgress > 0 ? inProgress : cancelled}
        detail={
          inProgress > 0
            ? `${inProgress} active background job${inProgress === 1 ? "" : "s"}`
            : `${percentage(cancelled)}% of operations`
        }
        tone={inProgress > 0 ? "blue" : "gray"}
        icon={inProgress > 0 ? "refresh" : "x-circle"}
      />

      <StatCard
        title="Partially completed"
        value={count("Partial")}
        detail={`${percentage(count("Partial"))}% of operations`}
        tone="gray"
        icon={"alert-triangle"}
      />

      <StatCard
        title="Failed / Expired"
        value={failed}
        detail={`${percentage(failed)}% of operations`}
        tone="red"
        icon={"alert-triangle"}
      />
    </s-grid>
  );
}
