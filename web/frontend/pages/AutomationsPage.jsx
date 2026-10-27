import { useEffect, useRef } from "react";
import AutomationCategories from "../components/automations/AutomationCategories.jsx";
import AutomationNotice from "../components/automations/AutomationNotice.jsx";
import AutomationTemplates from "../components/automations/AutomationTemplates.jsx";
import AutomationDialog from "../components/automations/AutomationDialog.jsx";
import useAutomationDashboard from "../hooks/useAutomationDashboard.js";
import {
  demoAutomations,
  getAutomationCounts,
} from "../data/automations.demo.js";
import { routes } from "../config/routes.js";
import "../styles/automations.css";

const demoCounts = getAutomationCounts(demoAutomations);

export default function AutomationsPage() {
  const dashboard = useAutomationDashboard();
  const pageRef = useRef(null);

  useEffect(() => {
    if (pageRef.current) {
      pageRef.current.inlineSize = "large";
      pageRef.current.setAttribute("inline-size", "large");
      pageRef.current.setAttribute("inlinesize", "large");
    }
  }, []);

  return (
    <s-page
      ref={pageRef}
      class="ma-page"
      heading="Automations"
      inlineSize="large"
      inline-size="large"
      inlinesize="large"
    >
      <s-link slot="breadcrumb-actions" href={routes.home}>
        Home
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        icon="layout-block"
        onClick={dashboard.openTemplates}
      >
        View templates
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        onClick={dashboard.openHelp}
      >
        How automations work
      </s-button>

      <div className="ma-container">
        <s-stack gap="base">
          {dashboard.noticeVisible && (
            <AutomationNotice onDismiss={dashboard.dismissNotice} />
          )}

          <AutomationCategories counts={demoCounts} />

          <AutomationTemplates
            onUseTemplate={dashboard.openTemplate}
            onViewAll={dashboard.openTemplates}
          />
        </s-stack>
      </div>

      <AutomationDialog
        dialog={dashboard.dialog}
        onClose={dashboard.closeDialog}
        onSelectTemplate={dashboard.openTemplate}
      />
    </s-page>
  );
}

export { AutomationsPage };
