import PlanCard from "./PlanCard.jsx";
export default function PlanGrid({ plans, currentPlanId, onChoose }) {
  return (
    <s-grid
      class="pb-plans"
      aria-label="Available subscription plans"
      gridTemplateColumns="@container (inline-size > 600px) '1fr 1fr', (inline-size > 900px) 'repeat(4, minmax(0, 1fr))', '1fr'"
      gap="base"
    >
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          current={plan.id === currentPlanId}
          onChoose={onChoose}
        />
      ))}
    </s-grid>
  );
}
