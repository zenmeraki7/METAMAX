export function MetricCard({ metric }) {
  const toneClass = metric.tone ? `home-icon-square--${metric.tone}` : "";

  return (
    <s-box
      border="base"
      borderRadius="base"
      padding="base"
      background="base"
    >
      <s-stack
        direction="inline"
        gap="base"
        alignItems="center"
      >
        <div className={`home-icon-square ${toneClass}`}>
          <s-icon type={metric.icon || "chart-vertical"} />
        </div>

        <s-stack
          gap="extra-tight"
          style={{ minWidth: 0, flex: 1 }}
        >
          <s-text color="subdued">
            {metric.label}
          </s-text>

          <s-text
            fontWeight="bold"
            style={{ fontSize: "1.3rem", lineHeight: 1.2 }}
          >
            {metric.value}
          </s-text>

          {metric.isLive ? (
            <s-stack
              direction="inline"
              gap="extra-tight"
              alignItems="center"
            >
              <span className="home-live-dot" aria-hidden="true" />
              <s-text color="subdued">
                {metric.subtext}
              </s-text>
            </s-stack>
          ) : (
            <s-text color="subdued">
              {metric.subtext}
            </s-text>
          )}
        </s-stack>
      </s-stack>
    </s-box>
  );
}

export default MetricCard;
