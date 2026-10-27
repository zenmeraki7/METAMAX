import { settingsHelpTopics } from "../../data/settings.js";
import { routes } from "../../config/routes.js";
export default function SettingsHelp({ onOpenHelp }) {
  return (
    <s-section class="ms-help-card" aria-labelledby="ms-help-heading">
      <s-stack gap="base">
        <s-stack
          class="ms-help-card__heading"
          direction="inline"
          gap="base"
          alignItems="center"
        >
          <s-icon type="question-circle" />

          <s-heading id="ms-help-heading">Need help?</s-heading>
        </s-stack>

        <s-stack class="ms-help-card__items" gap="base">
          {settingsHelpTopics.map((topic) => (
            <s-button
              key={topic.id}
              class="ms-help-item"
              onClick={() => onOpenHelp(topic.id)}
              icon="chevron-right"
            >
              <s-text>{topic.title}</s-text>
            </s-button>
          ))}

          <s-link class="ms-help-item" href={routes.support}>
            <s-text>Contact support</s-text>

            <s-icon type="chevron-right" />
          </s-link>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
