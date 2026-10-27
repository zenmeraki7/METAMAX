import SettingsItem from "./SettingsItem.jsx";
const icons = {
  database: "database",
  settings: "settings",
  lock: "lock",
};
export default function SettingsSection({ section }) {
  const Icon = icons[section.icon] ?? "settings";
  return (
    <s-section class="ms-section" aria-labelledby={`ms-section-${section.id}`}>
      <s-stack gap="base">
        <s-stack
          class="ms-section__header"
          direction="inline"
          gap="base"
          alignItems="center"
        >
          <s-stack
            class="ms-section__icon"
            aria-hidden="true"
            direction="inline"
            gap="small"
            alignItems="center"
          >
            <s-icon type={Icon} />
          </s-stack>

          <s-stack class="ms-section__heading" gap="base">
            <s-heading id={`ms-section-${section.id}`}>
              {section.title}
            </s-heading>

            <s-paragraph>{section.description}</s-paragraph>
          </s-stack>
        </s-stack>

        <s-stack class="ms-section__items" gap="base">
          {section.items.map((item) => (
            <SettingsItem key={item.id} item={item} />
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}
