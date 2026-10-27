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
    <s-section heading={category.title} style={{ height: "100%" }}>
      <s-badge
        slot="accessory"
        tone={activeCount > 0 ? "success" : "neutral"}
      >
        {activeCount} active
      </s-badge>

      <s-stack
        gap="small"
        justifyContent="space-between"
        style={{ height: "100%" }}
      >
        <s-paragraph color="subdued">{category.description}</s-paragraph>

        <s-stack
          direction="inline"
          gap="base"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-stack direction="inline" gap="small" alignItems="center" style={{ minWidth: 0, flex: "1 1 auto" }}>
            <s-icon type={ActionIcon} />
            <s-text color="subdued">
              <s-text type="strong">{category.actionTitle}: </s-text>
              {category.actionDescription}
            </s-text>
          </s-stack>

          <s-button
            variant="secondary"
            href={category.path}
            style={{ flexShrink: 0 }}
          >
            Configure
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export { AutomationCategoryCard };
