import { routes } from "../config/routes.js";

export const settingsSections = [
  {
    id: "store-data",
    title: "Store data",
    description:
      "Sync and manage your Shopify data used by the app.",
    icon: "database",
    items: [
      {
        id: "shopify-data",
        title: "Shopify data",
        description:
          "Sync your products, collections, metafields, locations and more.",
        icon: "refresh",
        href: routes.shopifyData,
      },
      {
        id: "metafields",
        title: "Metafields",
        description:
          "View and manage metafield definitions.",
        icon: "tag",
        href: routes.metafields,
      },
      {
        id: "markets",
        title: "Catalogs, markets and B2B",
        description:
          "Configure catalogs, markets and B2B settings.",
        icon: "globe",
        href: routes.markets,
      },
    ],
  },
  {
    id: "app-features",
    title: "App features",
    description:
      "Enable or customise features and integrations.",
    icon: "settings",
    items: [
      {
        id: "automations",
        title: "Automations",
        description:
          "Set up recurring edits and product rules.",
        icon: "zap",
        href: routes.automations,
      },
      {
        id: "integrations",
        title: "Integrations",
        description:
          "Connect with other apps and services.",
        icon: "workflow",
        href: routes.integrations,
      },
      {
        id: "snippets",
        title: "Code snippets",
        description:
          "Edit products using custom Liquid code.",
        icon: "code",
        href: routes.codeSnippets,
      },
    ],
  },
  {
    id: "account",
    title: "Account",
    description:
      "Manage your plan and subscription settings.",
    icon: "lock",
    items: [
      {
        id: "plan",
        title: "Plan",
        description:
          "View plan details, usage and billing settings.",
        icon: "credit-card",
        href: routes.plan,
      },
    ],
  },
];

export const settingsHelpTopics = [
  {
    id: "sync",
    title: "How data syncing works",
    content:
      "METAMAX maintains a database mirror of supported Shopify resources. Initial and repair synchronizations fetch Shopify's authoritative data. Webhook reconciliation keeps supported resources current between full synchronizations.",
  },
  {
    id: "metafields",
    title: "Managing metafields",
    content:
      "Metafields contain additional information associated with Shopify resources. METAMAX can use supported metafield definitions and values in product filtering and bulk editing.",
  },
  {
    id: "automations",
    title: "Automations guide",
    content:
      "Recurring edits execute on schedules. Product rules respond to qualifying product changes. The backend must validate eligibility and persist executions so jobs can continue when the app is closed.",
  },
];
