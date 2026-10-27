import useModalOverlay from "../../hooks/useModalOverlay.js";
import { useRef } from "react";
import { routes } from "../../config/routes.js";
import { automationTemplates } from "../../data/automations.demo.js";
export default function AutomationDialog({
  dialog,
  onClose,
  onSelectTemplate,
}) {
  const dialogRef = useRef(null);
  useModalOverlay(dialogRef, Boolean(dialog), onClose);
  const title =
    dialog?.type === "help"
      ? "How automations work"
      : dialog?.type === "templates"
        ? "Automation templates"
        : (dialog?.template?.title ?? "Automation");
  const selectedTemplate = dialog?.type === "template" ? dialog.template : null;
  const destination =
    selectedTemplate?.category === "recurring"
      ? routes.recurringEdits
      : routes.productRules;
  return (
    <s-modal ref={dialogRef} id="automation-details" heading={title}>
      {dialog && (
        <>
          {dialog.type === "help" && (
            <s-stack class="ma-dialog__body" gap="base">
              <s-stack class="ma-help-row" direction="inline" gap="base">
                <s-icon type="calendar" />

                <s-stack gap="base">
                  <s-text type="strong">Recurring edits</s-text>

                  <s-paragraph>
                    Set up edits to run daily, weekly, monthly or on a custom
                    schedule.
                  </s-paragraph>
                </s-stack>
              </s-stack>

              <s-stack class="ma-help-row" direction="inline" gap="base">
                <s-icon type="note" />

                <s-stack gap="base">
                  <s-text type="strong">Product rules</s-text>

                  <s-paragraph>
                    Apply configured changes when Shopify products are created
                    or updated and meet your conditions.
                  </s-paragraph>
                </s-stack>
              </s-stack>

              <s-paragraph class="ma-dialog__note">
                In production, your backend runs the scheduled jobs and
                maintains execution history even when the merchant closes the
                embedded app.
              </s-paragraph>

              <s-button
                href={routes.history}
                icon="arrow-right"
                class="ma-dialog__primary"
                commandFor="automation-details"
                command="--hide"
              >
                View execution history
              </s-button>
            </s-stack>
          )}

          {dialog.type === "templates" && (
            <s-stack class="ma-dialog__body" gap="base">
              <s-paragraph class="ma-dialog__intro">
                Choose a starting point for your automation.
              </s-paragraph>

              <s-stack class="ma-dialog__templates" gap="base">
                {automationTemplates.map((template) => (
                  <s-button
                    key={template.id}
                    onClick={() => onSelectTemplate(template)}
                    icon="arrow-right"
                  >
                    <s-text>
                      <s-text type="strong">{template.title}</s-text>

                      <s-text color="subdued">{template.description}</s-text>
                    </s-text>
                  </s-button>
                ))}
              </s-stack>
            </s-stack>
          )}

          {selectedTemplate && (
            <s-stack class="ma-dialog__body" gap="base">
              <s-paragraph class="ma-dialog__intro">
                {selectedTemplate.description}
              </s-paragraph>

              <s-stack class="ma-dialog__preview" gap="base">
                <s-text>Automation type</s-text>

                <s-text type="strong">
                  {selectedTemplate.category === "recurring"
                    ? "Recurring edit"
                    : "Product rule"}
                </s-text>
              </s-stack>

              <s-paragraph class="ma-dialog__note">
                This is a demo template preview. Creating and activating an
                automation requires your authenticated backend workflow.
              </s-paragraph>

              <s-button
                class="ma-dialog__primary"
                href={destination}
                commandFor="automation-details"
                command="--hide"
              >
                Continue to setup
              </s-button>
            </s-stack>
          )}
        </>
      )}
      <s-button
        slot="secondary-actions"
        commandFor="automation-details"
        command="--hide"
      >
        Done
      </s-button>
    </s-modal>
  );
}
