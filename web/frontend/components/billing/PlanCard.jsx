const icons = {
  sprout: "flower",
  growth: "chart-vertical",
  star: "star",
  users: "person",
};
export default function PlanCard({ plan, current, onChoose }) {
  const Icon = icons[plan.icon] ?? "star";
  return (
    <s-section
      class={[
        "pb-plan-card",
        `pb-plan-card--${plan.tone}`,
        current ? "pb-plan-card--current" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <s-stack gap="base">
        {current && (
          <s-stack
            class="pb-current-label"
            direction="inline"
            gap="small"
            alignItems="center"
          >
            <s-icon type="star" />
            Current plan
          </s-stack>
        )}

        <s-stack
          class="pb-plan-card__icon"
          aria-hidden="true"
          direction="inline"
          gap="base"
          alignItems="center"
        >
          <s-icon type={Icon} />
        </s-stack>

        <s-heading>{plan.name}</s-heading>

        <s-stack class="pb-plan-card__price" direction="inline" gap="base">
          <s-text type="strong">${plan.price}</s-text>

          <s-text>/month</s-text>
        </s-stack>

        <s-button
          class={
            current
              ? "pb-plan-card__button pb-plan-card__button--current"
              : "pb-plan-card__button"
          }
          disabled={current}
          onClick={() => onChoose(plan)}
          accessibilityLabel={
            current
              ? `${plan.name} is your current plan`
              : `Choose ${plan.name} plan`
          }
        >
          {current ? "Current plan" : "Choose plan"}
        </s-button>
      </s-stack>
    </s-section>
  );
}
