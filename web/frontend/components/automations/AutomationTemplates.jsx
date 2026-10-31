import AutomationTemplateCard from "./AutomationTemplateCard.jsx";
import { automationTemplates } from "../../data/automations.demo.js";

export default function AutomationTemplates({ onUseTemplate, onViewAll }) {
  return (
    <s-section heading="Quick action templates">
      <s-button slot="accessory" variant="tertiary" onClick={onViewAll}>
        View all
      </s-button>

      <s-grid
        gridTemplateColumns="@container (inline-size > 600px) 'repeat(2, minmax(0, 1fr))', (inline-size > 1100px) 'repeat(4, minmax(0, 1fr))', '1fr'"
        gap="base"
      >
        {automationTemplates.map((template) => (
          <AutomationTemplateCard
            key={template.id}
            template={template}
            onUse={onUseTemplate}
          />
        ))}
      </s-grid>
    </s-section>
  );
}

export { AutomationTemplates };
