export const demoProductInsights = {
  period: "30 days",
  sellThrough: "0%",
  inventoryRemaining: "No data",
  abcValue: "₹119,880.00",
  abcGrade: "C",
};

const product = (id, title, vendor, extras = {}) => ({
  id,
  title,
  vendor,
  status: "Active",
  inventory: null,
  category: "",
  channels: 0,
  catalogs: 1,
  productType: "",
  image: null,
  ...extras,
});

export const demoProducts = [
  product(
    "p-4706-a",
    "Product 4706 new arrived akhila",
    "Vendor 6 NEW akhila"
  ),

  product(
    "p-4706-b",
    "Product 4706 new arrived",
    "Vendor 6 NEW"
  ),

  ...[1, 2, 3].map((number) =>
    product(
      `p-moon-${number}`,
      "moon-drenched stormy glacial bush new arrived",
      "Demo Zen Store"
    )
  ),

  product("p-omega", "Omega Trainer", "Demo Zen Store", {
    inventory: "0 in stock",
    category: "Sneakers",
    channels: 9,
    image: "/shoe.png",
  }),

  product("p-jeans", "Baggy jeans", "Demo Zen Store", {
    inventory: "0 in stock",
    category: "Jeans",
    channels: 9,
  }),

  product(
    "p-saree",
    "cotton saree cloth addeded",
    "Demo Zen Store addeded",
    {
      status: "Archived",
      inventory: "0 in stock for 48 variants",
      category: "Saris & Lehengas",
      channels: 9,
      productType: "Dresses",
      image: "/saree.png",
    }
  ),
];

export const productColumns = [
  { key: "status", label: "Status" },
  { key: "inventory", label: "Inventory" },
  { key: "category", label: "Category" },
  { key: "channels", label: "Channels" },
  { key: "catalogs", label: "Catalogs" },
  { key: "productType", label: "Product type" },
  { key: "vendor", label: "Vendor" },
];
