const icons = {
  refresh: "refresh",
  document: "note",
  calendar: "calendar",
  tag: "tag",
};

export default function AutomationCategoryCard({ category, activeCount }) {
  const MainIcon = icons[category.icon] ?? "refresh";
  const ActionIcon = icons[category.actionIcon] ?? "calendar";

  return (
    <s-section heading={category.title}>
      <s-badge slot="accessory" tone={activeCount > 0 ? "success" : "neutral"}>
        {activeCount} active
      </s-badge>

      <s-stack gap="small" justifyContent="space-between">
        <s-paragraph color="subdued">{category.description}</s-paragraph>

        <s-stack
          direction="inline"
          gap="base"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-icon type={ActionIcon} />
            <s-text color="subdued">
              <s-text type="strong">{category.actionTitle}: </s-text>
              {category.actionDescription}
            </s-text>
          </s-stack>

          <s-button variant="secondary" href={category.path}>
            Configure
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export { AutomationCategoryCard };
