const icons = {
  refresh: "refresh",
  tag: "tag",
  globe: "globe",
  zap: "bolt",
  workflow: "automation",
  code: "code",
  "credit-card": "credit-card",
};
export default function SettingsItem({ item }) {
  const Icon = icons[item.icon] ?? "tag";
  return (
    <s-link class="ms-setting-item" href={item.href}>
      <s-grid
        gridTemplateColumns="auto minmax(0, 1fr) auto"
        gap="base"
        alignItems="center"
      >
        <s-stack
          class="ms-setting-item__icon"
          aria-hidden="true"
          direction="inline"
          gap="small"
          alignItems="center"
        >
          <s-icon type={Icon} />
        </s-stack>

        <s-stack gap="small">
          <s-text type="strong">{item.title}</s-text>

          <s-text>{item.description}</s-text>
        </s-stack>

        <s-icon type="chevron-right" />
      </s-grid>
    </s-link>
  );
}
