export const demoAutomations = [
  {
    id: "recurring-001",
    name: "Weekly price update",
    type: "recurring",
    status: "active",
  },
  {
    id: "recurring-002",
    name: "Daily inventory adjustment",
    type: "recurring",
    status: "active",
  },
  {
    id: "recurring-003",
    name: "Monthly metafield update",
    type: "recurring",
    status: "active",
  },
  {
    id: "rule-001",
    name: "Apply tags to new products",
    type: "rule",
    status: "active",
  },
  {
    id: "rule-002",
    name: "Add products to collections",
    type: "rule",
    status: "active",
  },
];

export const automationCategories = [
  {
    id: "recurring",
    title: "Recurring edits",
    description:
      "Run edits on a repeating schedule. Useful for price changes, inventory updates, metafields, and more.",
    actionTitle: "Set a schedule",
    actionDescription:
      "Daily, weekly, monthly or custom",
    tone: "blue",
    icon: "refresh",
    actionIcon: "calendar",
    path: "/automations/recurring",
  },
  {
    id: "rule",
    title: "Product rules",
    description:
      "Automatically apply modifications when products are created or updated.",
    actionTitle: "Set conditions",
    actionDescription:
      "Based on product data, collections, tags and more",
    tone: "purple",
    icon: "document",
    actionIcon: "tag",
    path: "/automations/rules",
  },
];

export const automationTemplates = [
  {
    id: "price-update",
    title: "Schedule price update",
    description:
      "Increase or decrease product prices on a schedule.",
    icon: "tag",
    tone: "green",
    category: "recurring",
  },
  {
    id: "inventory-update",
    title: "Update inventory",
    description:
      "Sync inventory or set stock levels on a schedule.",
    icon: "package",
    tone: "blue",
    category: "recurring",
  },
  {
    id: "apply-tags",
    title: "Apply tags",
    description:
      "Add or remove tags based on conditions.",
    icon: "tag",
    tone: "purple",
    category: "rule",
  },
  {
    id: "add-collections",
    title: "Add to collections",
    description:
      "Automatically add products to collections.",
    icon: "folder",
    tone: "orange",
    category: "rule",
  },
];

export function getAutomationCounts(automations) {
  return automations.reduce(
    (counts, automation) => {
      if (automation.status !== "active") {
        return counts;
      }

      if (automation.type === "recurring") {
        counts.recurring += 1;
      }

      if (automation.type === "rule") {
        counts.rule += 1;
      }

      return counts;
    },
    { recurring: 0, rule: 0 }
  );
}
