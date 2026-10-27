export default function AutomationNotice({ onDismiss }) {
  return (
    <s-banner
      tone="info"
      dismissible
      onDismiss={onDismiss}
    >
      Automations run continuously in the background even when you close the app.
      Review execution logs anytime in History.
    </s-banner>
  );
}

export { AutomationNotice };
