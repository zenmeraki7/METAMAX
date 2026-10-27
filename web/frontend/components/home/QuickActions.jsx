import { Link } from "react-router-dom";
import { routes } from "../../config/routes.js";

const quickActions = [
  {
    id: "bulk-edit",
    title: "Bulk edit products",
    subtitle: "Update multiple fields at once",
    icon: "edit",
    tone: "blue",
    href: routes.bulkEdit,
  },
  {
    id: "spreadsheet",
    title: "Edit with spreadsheet",
    subtitle: "Upload, edit and re-import",
    icon: "table",
    tone: "green",
    href: routes.import,
  },
  {
    id: "export",
    title: "Export product data",
    subtitle: "Export to CSV, Excel, or Google",
    icon: "export",
    tone: "purple",
    href: routes.export,
  },
];

export function QuickActions() {
  return (
    <section aria-label="Primary actions">
      <s-grid
        gridTemplateColumns="@container (inline-size > 800px) repeat(3, minmax(0, 1fr)), 1fr"
        gap="base"
      >
        {quickActions.map((action) => (
          <Link
            key={action.id}
            to={action.href}
            className="home-action-card"
          >
            <s-box
              border="base"
              borderRadius="base"
              padding="base"
              background="base"
            >
              <s-stack
                direction="inline"
                alignItems="center"
                justifyContent="space-between"
                gap="base"
              >
                <s-stack
                  direction="inline"
                  alignItems="center"
                  gap="base"
                  style={{ minWidth: 0, flex: 1 }}
                >
                  <div className={`home-icon-square home-icon-square--${action.tone}`}>
                    <s-icon type={action.icon} />
                  </div>

                  <s-stack gap="extra-tight" style={{ minWidth: 0 }}>
                    <s-text fontWeight="bold">
                      {action.title}
                    </s-text>
                    <s-text color="subdued">
                      {action.subtitle}
                    </s-text>
                  </s-stack>
                </s-stack>

                <s-icon type="chevron-right" />
              </s-stack>
            </s-box>
          </Link>
        ))}
      </s-grid>
    </section>
  );
}

export default QuickActions;
