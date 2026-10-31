import { routes } from "../../config/routes.js";
export default function AppNavigation() {
  return (
    <s-app-nav>
      <s-link href={routes.home}>Home</s-link>

      <s-link href={routes.products}>Products</s-link>

      <s-link href={routes.savedViews}>Saved views</s-link>

      <s-link href={routes.automations}>Automations</s-link>

      <s-link href={routes.history}>History</s-link>

      <s-link href={routes.settings}>Settings</s-link>
    </s-app-nav>
  );
}
