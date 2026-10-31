export default function AutomationNotice({ onDismiss }) {
  return (
    <s-banner tone="info" dismissible ondismiss={onDismiss}>
      These are example automations. Configuring a template here does not start
      a live background job.
    </s-banner>
  );
}

export { AutomationNotice };
