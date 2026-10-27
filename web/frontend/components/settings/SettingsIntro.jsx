export default function SettingsIntro({ onViewDocumentation }) {
  return (
    <s-stack
      class="ms-intro"
      direction="inline"
      gap="base"
      justifyContent="space-between"
    >
      <s-stack class="ms-intro__copy" gap="base">
        <s-heading>Settings</s-heading>

        <s-paragraph>
          Manage how the app works with your store data and configure features.
        </s-paragraph>
      </s-stack>

      <s-button
        class="ms-documentation"
        onClick={onViewDocumentation}
        icon="book"
      >
        View documentation
      </s-button>
    </s-stack>
  );
}
