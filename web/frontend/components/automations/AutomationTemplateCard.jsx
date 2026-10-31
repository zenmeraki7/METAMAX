const icons = {
  tag: "tag",
  package: "product",
  folder: "folder",
};

export default function AutomationTemplateCard({ template, onUse }) {
  const Icon = icons[template.icon] ?? "tag";
  const categoryLabel =
    template.category === "recurring" ? "Schedule" : "Event rule";

  return (
    <s-box border="base" borderRadius="base" background="base" padding="base">
      <s-stack gap="small" justifyContent="space-between">
        <s-stack gap="small">
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
          >
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-icon type={Icon} />
              <s-text type="strong">{template.title}</s-text>
            </s-stack>

            <s-badge
              tone={template.category === "recurring" ? "info" : "magic"}
            >
              {categoryLabel}
            </s-badge>
          </s-stack>

          <s-paragraph color="subdued">{template.description}</s-paragraph>
        </s-stack>

        <s-button variant="secondary" onClick={() => onUse(template)}>
          Use template
        </s-button>
      </s-stack>
    </s-box>
  );
}

export { AutomationTemplateCard };
