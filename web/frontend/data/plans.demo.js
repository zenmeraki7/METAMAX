export const demoPlans = [
  {
    id: "starter",
    name: "Starter",
    price: 19,
    currency: "USD",
    interval: "month",
    icon: "sprout",
    tone: "gray",
    features: [
      "Basic bulk editing",
      "Product filtering",
      "CSV export",
      "Standard support",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    price: 49,
    currency: "USD",
    interval: "month",
    icon: "growth",
    tone: "blue",
    features: [
      "Advanced bulk editing",
      "Scheduled edits",
      "Product metafields",
      "Priority support",
    ],
  },
  {
    id: "professional",
    name: "Professional",
    price: 99,
    currency: "USD",
    interval: "month",
    icon: "star",
    tone: "green",
    features: [
      "Everything in Growth",
      "Product rules",
      "Advanced imports and exports",
      "Automation history",
    ],
  },
  {
    id: "scale",
    name: "Scale",
    price: 199,
    currency: "USD",
    interval: "month",
    icon: "users",
    tone: "purple",
    features: [
      "Everything in Professional",
      "High-volume workflows",
      "Expanded automation limits",
      "Dedicated support",
    ],
  },
];

export const demoBilling = {
  currentPlanId: "growth",

  nextBillingDate: "Nov 25, 2024",
  billingDateDescription: "In 28 days",

  paymentMethod: {
    brand: "mastercard",
    last4: "4242",
    expiry: "08/2028",
  },
};
