import PlanGrid from "../components/billing/PlanGrid.jsx";
import BillingDetails from "../components/billing/BillingDetails.jsx";
import BillingHelp from "../components/billing/BillingHelp.jsx";
import BillingDialog from "../components/billing/BillingDialog.jsx";
import usePlanBilling from "../hooks/usePlanBilling.js";
import { demoPlans, demoBilling } from "../data/plans.demo.js";
export default function PlanBillingPage() {
  const billing = usePlanBilling();
  return (
    <s-page class="pb-page" heading="Plan & billing">
      <s-link slot="breadcrumb-actions" href="/settings">
        Settings
      </s-link>
      <s-paragraph>
        Choose the plan that fits your store and manage billing.
      </s-paragraph>
      <s-stack gap="base">
        <s-banner tone="info">
          These are example plans and billing details. No charges are created
          from this page.
        </s-banner>
        <s-stack class="pb-content" gap="base">
          <PlanGrid
            plans={demoPlans}
            currentPlanId={demoBilling.currentPlanId}
            onChoose={billing.choosePlan}
          />

          <s-grid
            class="pb-lower-grid"
            gridTemplateColumns="@container (inline-size > 600px) '1fr 1fr', (inline-size > 900px) 'repeat(2, minmax(0, 1fr))', '1fr'"
            gap="base"
          >
            <BillingDetails
              billing={demoBilling}
              onManageBilling={billing.manageBilling}
            />

            <BillingHelp onComparePlans={billing.comparePlans} />
          </s-grid>
        </s-stack>

        <BillingDialog
          dialog={billing.dialog}
          plans={demoPlans}
          currentPlanId={demoBilling.currentPlanId}
          onClose={billing.closeDialog}
        />
      </s-stack>
    </s-page>
  );
}
