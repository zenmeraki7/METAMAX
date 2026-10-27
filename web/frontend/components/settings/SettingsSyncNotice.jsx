export default function SettingsSyncNotice() {
  return (
    <s-stack
      class="ms-sync-notice"
      aria-label="Shopify synchronization information"
      direction="inline"
      gap="base"
    >
      <s-stack
        class="ms-sync-notice__icon"
        aria-hidden="true"
        direction="inline"
        gap="small"
        alignItems="center"
      >
        <s-icon type="info" />
      </s-stack>

      <s-stack gap="base">
        <s-heading>Keep your data in sync</s-heading>

        <s-paragraph>
          The app maintains a synced copy of your Shopify data for faster
          searches and reliable bulk edits. If you make changes in Shopify that
          aren't appearing in the app, use the refresh button above or sync
          manually.
        </s-paragraph>
      </s-stack>
    </s-stack>
  );
}
