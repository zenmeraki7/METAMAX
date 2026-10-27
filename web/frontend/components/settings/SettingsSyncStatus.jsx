export default function SettingsSyncStatus({
  status,
  lastFullSync,
  refreshing,
  onSync,
  isDemo,
}) {
  return (
    <s-section class="ms-sync-card" aria-labelledby="ms-sync-heading">
      <s-stack gap="base">
        <s-heading id="ms-sync-heading">Data sync status</s-heading>

        <s-stack class="ms-sync-card__state" gap="base" alignItems="center">
          <s-badge tone={status.tone}>{status.label}</s-badge>
        </s-stack>

        <s-stack
          class="ms-sync-card__bottom"
          direction="inline"
          gap="base"
          justifyContent="space-between"
        >
          <s-stack class="ms-sync-card__details" gap="base">
            <s-text>Last full sync</s-text>

            <s-text type="strong">{lastFullSync}</s-text>

            {isDemo && <s-text color="subdued">Demo data</s-text>}

            {!isDemo && status.description && (
              <s-text color="subdued">{status.description}</s-text>
            )}
          </s-stack>

          <s-button
            class="ms-sync-button"
            onClick={onSync}
            disabled={refreshing}
            loading={refreshing}
            icon="refresh"
          >
            {refreshing ? "Requesting..." : "Sync now"}
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
