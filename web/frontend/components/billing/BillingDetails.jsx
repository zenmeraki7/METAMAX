export default function BillingDetails({ billing, onManageBilling }) {
  const method = billing.paymentMethod;
  return (
    <s-section class="pb-details" aria-labelledby="pb-billing-details">
      <s-stack gap="base">
        <s-stack
          class="pb-panel-heading"
          direction="inline"
          gap="base"
          alignItems="center"
        >
          <s-icon type="credit-card" />

          <s-heading id="pb-billing-details">Billing details</s-heading>
        </s-stack>

        <s-stack class="pb-details__rows" gap="base">
          <s-grid
            class="pb-details__row"
            gridTemplateColumns="@container (inline-size > 900px) minmax(0, 1fr) minmax(0, 0.85fr), @container (inline-size > 600px) 1fr 1fr, 1fr"
            gap="base"
          >
            <s-text class="pb-details__label">Next billing date</s-text>

            <s-stack class="pb-details__value" gap="base">
              <s-text type="strong">{billing.nextBillingDate}</s-text>

              <s-text>{billing.billingDateDescription}</s-text>
            </s-stack>
          </s-grid>

          <s-grid
            class="pb-details__row"
            gridTemplateColumns="@container (inline-size > 900px) minmax(0, 1fr) minmax(0, 0.85fr), @container (inline-size > 600px) 1fr 1fr, 1fr"
            gap="base"
          >
            <s-text class="pb-details__label">Payment method</s-text>

            <s-stack class="pb-details__payment" direction="inline" gap="base">
              <s-text
                class="pb-mastercard"
                aria-label="Demo Mastercard payment method"
              >
                <s-text />
                <s-text />
              </s-text>

              <s-stack class="pb-details__value" gap="base">
                <s-text type="strong">•••• {method.last4}</s-text>

                <s-text>Expires {method.expiry}</s-text>
              </s-stack>
            </s-stack>
          </s-grid>
        </s-stack>

        <s-button class="pb-manage-button" onClick={onManageBilling}>
          Manage billing
        </s-button>
      </s-stack>
    </s-section>
  );
}
