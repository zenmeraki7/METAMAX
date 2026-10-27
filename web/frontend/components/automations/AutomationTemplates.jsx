import AutomationTemplateCard from "./AutomationTemplateCard.jsx";
import { automationTemplates } from "../../data/automations.demo.js";

export default function AutomationTemplates({ onUseTemplate, onViewAll }) {
  return (
    <s-section heading="Quick action templates">
      <s-button
        slot="accessory"
        variant="tertiary"
        onClick={onViewAll}
      >
        View all
      </s-button>

      <div className="ma-templates-row">
        {automationTemplates.map((template) => (
          <AutomationTemplateCard
            key={template.id}
            template={template}
            onUse={onUseTemplate}
          />
        ))}
      </div>
    </s-section>
  );
}

export { AutomationTemplates };
