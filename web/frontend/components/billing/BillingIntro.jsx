import { routes } from "../../config/routes.js";
export default function BillingIntro() {
  return (
    <s-section class="pb-intro">
      <s-stack gap="base">
        <s-stack
          class="pb-breadcrumb"
          aria-label="Breadcrumb"
          direction="inline"
          gap="base"
          alignItems="center"
        >
          <s-link href={routes.settings} accessibilityLabel="Back to settings">
            <s-icon type="chevron-left" />
          </s-link>

          <s-link href={routes.settings}>Settings</s-link>

          <s-text class="pb-breadcrumb__divider">/</s-text>

          <s-text aria-current="page" type="strong">
            Plan &amp; billing
          </s-text>
        </s-stack>

        <s-stack class="pb-intro__heading" gap="base">
          <s-heading>Plan &amp; billing</s-heading>

          <s-paragraph>
            Choose the plan that fits your store and manage billing.
          </s-paragraph>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
