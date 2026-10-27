import { routes } from "../../config/routes.js";
export default function BillingHelp({ onComparePlans }) {
  return (
    <s-section class="pb-help" aria-labelledby="pb-help-heading">
      <s-stack gap="base">
        <s-stack
          class="pb-panel-heading"
          direction="inline"
          gap="base"
          alignItems="center"
        >
          <s-icon type="question-circle" />

          <s-heading id="pb-help-heading">Need help?</s-heading>
        </s-stack>

        <s-stack class="pb-help__items" gap="base">
          <s-button
            class="pb-help__item"
            onClick={onComparePlans}
            icon="chevron-right"
          >
            <s-stack
              class="pb-help__icon"
              aria-hidden="true"
              direction="inline"
              gap="small"
              alignItems="center"
            >
              <s-icon type="note" />
            </s-stack>

            <s-text class="pb-help__copy">
              <s-text type="strong">Compare plans</s-text>
              <s-text>See what's included in each plan</s-text>
            </s-text>
          </s-button>

          <s-link class="pb-help__item" href={routes.support}>
            <s-stack
              class="pb-help__icon"
              aria-hidden="true"
              direction="inline"
              gap="small"
              alignItems="center"
            >
              <s-icon type="chat" />
            </s-stack>

            <s-text class="pb-help__copy">
              <s-text type="strong">Contact support</s-text>
              <s-text>Get help from our team</s-text>
            </s-text>

            <s-icon type="chevron-right" />
          </s-link>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
