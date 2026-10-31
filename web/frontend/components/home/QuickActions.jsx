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
        gridTemplateColumns="@container (inline-size > 800px) 'repeat(3, minmax(0, 1fr))', '1fr'"
        gap="base"
      >
        {quickActions.map((action) => (
          <Link key={action.id} to={action.href} className="home-action-card">
            <s-box
              border="base"
              borderRadius="base"
              padding="base"
              background="base"
            >
              <s-grid
                gridTemplateColumns="minmax(0, 1fr) auto"
                alignItems="center"
                gap="base"
              >
                <s-grid
                  gridTemplateColumns="auto minmax(0, 1fr)"
                  alignItems="center"
                  gap="base"
                >
                  <s-box
                    padding="small"
                    background="subdued"
                    borderRadius="base"
                  >
                    <s-icon type={action.icon} />
                  </s-box>

                  <s-stack gap="small">
                    <s-text type="strong">{action.title}</s-text>
                    <s-text color="subdued">{action.subtitle}</s-text>
                  </s-stack>
                </s-grid>

                <s-icon type="chevron-right" />
              </s-grid>
            </s-box>
          </Link>
        ))}
      </s-grid>
    </section>
  );
}

export default QuickActions;
