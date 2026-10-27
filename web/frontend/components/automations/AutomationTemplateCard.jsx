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
    <div className="ma-template-card">
      <s-stack
        gap="small"
        justifyContent="space-between"
        style={{ height: "100%" }}
      >
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

          <s-paragraph color="subdued">
            {template.description}
          </s-paragraph>
        </s-stack>

        <s-button
          variant="secondary"
          onClick={() => onUse(template)}
        >
          Use template
        </s-button>
      </s-stack>
    </div>
  );
}

export { AutomationTemplateCard };
