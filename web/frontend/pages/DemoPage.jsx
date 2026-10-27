import { routes } from "../config/routes.js";
export default function DemoPage({ title = "Page" }) {
  const displayTitle = title || "Page";
  return (
    <s-page heading={displayTitle}>
      <s-link slot="breadcrumb-actions" href={routes.home}>
        Home
      </s-link>

      <s-stack class="demo-route" gap="base">
        <s-text class="demo-route__badge">DEMO ROUTE</s-text>

        <s-paragraph>
          Connect this route to the existing METAMAX
          {` ${displayTitle.toLowerCase()}`} workspace.
        </s-paragraph>
      </s-stack>
    </s-page>
  );
}
export { DemoPage };
