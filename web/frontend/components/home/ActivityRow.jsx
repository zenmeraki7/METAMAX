export default function ActivityRow({ activity }) {
  const toneClass = activity.tone ? `home-icon-square--${activity.tone}` : "";

  return (
    <s-box paddingBlock="small">
      <s-stack
        direction="inline"
        gap="base"
        alignItems="center"
        justifyContent="space-between"
      >
        <s-stack
          direction="inline"
          gap="base"
          alignItems="center"
          style={{ minWidth: 0, flex: 1 }}
        >
          <div className={`home-icon-square ${toneClass}`}>
            <s-icon type={activity.icon || "clock"} />
          </div>

          <s-stack gap="extra-tight" style={{ minWidth: 0 }}>
            <s-text fontWeight="bold">
              {activity.title}
            </s-text>

            {activity.detail && (
              <s-text color="subdued">
                {activity.detail}
              </s-text>
            )}
          </s-stack>
        </s-stack>

        <s-text color="subdued" style={{ whiteSpace: "nowrap" }}>
          {activity.when}
        </s-text>
      </s-stack>
    </s-box>
  );
}

export { ActivityRow };
