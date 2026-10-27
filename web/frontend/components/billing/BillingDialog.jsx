import useModalOverlay from "../../hooks/useModalOverlay.js";
import { useRef } from "react";
export default function BillingDialog({
  dialog,
  plans,
  currentPlanId,
  onClose,
}) {
  const dialogRef = useRef(null);
  useModalOverlay(dialogRef, Boolean(dialog), onClose);
  const heading =
    dialog?.type === "plan"
      ? `${dialog.plan.name} plan`
      : dialog?.type === "compare"
        ? "Compare plans"
        : "Manage billing";
  return (
    <s-modal ref={dialogRef} id="billing-details" heading={heading}>
      {dialog && (
        <>
          <s-stack class="pb-dialog__body" gap="base">
            {dialog.type === "plan" && (
              <>
                <s-paragraph>
                  <s-text type="strong">${dialog.plan.price}/month</s-text>
                </s-paragraph>

                <s-paragraph>Features included in this demo plan:</s-paragraph>

                <s-grid
                  class="pb-dialog__features"
                  gridTemplateColumns="@container (inline-size > 900px) 1fr, @container (inline-size > 600px) 1fr 1fr, 1fr"
                  gap="base"
                >
                  {dialog.plan.features.map((feature) => (
                    <s-stack key={feature} gap="base">
                      <s-icon type="check" />
                      <s-text>{feature}</s-text>
                    </s-stack>
                  ))}
                </s-grid>

                <s-paragraph class="pb-dialog__notice">
                  Demo preview only. No subscription will be created or changed.
                  Production plan selection must be approved through Shopify's
                  billing system.
                </s-paragraph>
              </>
            )}

            {dialog.type === "compare" && (
              <>
                <s-paragraph>
                  Compare the available METAMAX demonstration plans.
                </s-paragraph>

                <s-stack class="pb-dialog__table-scroll" gap="base">
                  <s-table>
                    <s-table-header-row>
                      <s-table-header>Plan</s-table-header>
                      <s-table-header>Monthly</s-table-header>
                      <s-table-header>Included features</s-table-header>
                    </s-table-header-row>

                    <s-table-body>
                      {plans.map((plan) => (
                        <s-table-row key={plan.id}>
                          <s-table-cell>
                            <s-text type="strong">{plan.name}</s-text>

                            {plan.id === currentPlanId && (
                              <s-text class="pb-dialog__current">
                                Current
                              </s-text>
                            )}
                          </s-table-cell>

                          <s-table-cell>${plan.price}</s-table-cell>

                          <s-table-cell>
                            {plan.features.join(", ")}
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                </s-stack>
              </>
            )}

            {dialog.type === "billing" && (
              <>
                <s-paragraph>
                  Billing is managed through Shopify. This page currently
                  displays demo payment information.
                </s-paragraph>

                <s-paragraph class="pb-dialog__notice">
                  Your production integration should retrieve the merchant's
                  authorized subscription status and direct billing changes
                  through Shopify. It should not collect or store payment card
                  details in METAMAX.
                </s-paragraph>
              </>
            )}

            <s-stack
              class="pb-dialog__footer"
              direction="inline"
              gap="base"
            ></s-stack>
          </s-stack>
        </>
      )}
      <s-button
        slot="secondary-actions"
        commandFor="billing-details"
        command="--hide"
      >
        Done
      </s-button>
    </s-modal>
  );
}
