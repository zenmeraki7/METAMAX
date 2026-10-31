export default function ActivityRow({ activity }) {
  return (
    <s-box paddingBlock="small">
      <s-grid
        gridTemplateColumns="auto minmax(0, 1fr) auto"
        gap="base"
        alignItems="center"
      >
        <s-box padding="small" background="subdued" borderRadius="base">
          <s-icon type={activity.icon || "clock"} />
        </s-box>
        <s-stack gap="small">
          <s-text type="strong">{activity.title}</s-text>
          {activity.detail && (
            <s-text color="subdued">{activity.detail}</s-text>
          )}
        </s-stack>
        <s-text color="subdued">{activity.when}</s-text>
      </s-grid>
    </s-box>
  );
}
export { ActivityRow };
