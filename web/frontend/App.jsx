import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AppNavigation from "./components/layout/AppNavigation.jsx";
import HomePage from "./pages/HomePage.jsx";
import ProductsPage from "./pages/ProductsPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import AutomationsPage from "./pages/AutomationsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import ShopifyDataPage from "./pages/ShopifyDataPage.jsx";
import PlanBillingPage from "./pages/PlanBillingPage.jsx";
import DemoPage from "./pages/DemoPage.jsx";
import { routes } from "./config/routes.js";

import "./styles.css";
const demoPages = [
  [routes.bulkEdit, "Bulk edit"],
  [routes.import, "Import"],
  [routes.export, "Export"],
  [routes.savedViews, "Saved views"],
  [routes.catalogSync, "Catalog sync"],
  [routes.support, "Help & Support"],
  [routes.recurringEdits, "Recurring edits"],
  [routes.productRules, "Product rules"],
  [routes.metafields, "Metafields"],
  [routes.markets, "Catalogs, markets and B2B"],
  [routes.integrations, "Integrations"],
  [routes.codeSnippets, "Code snippets"],
];

export default function App() {
  return (
    <>
      <BrowserRouter>
        <AppNavigation />

        <s-query-container>
          <Routes>
            <Route path={routes.home} element={<HomePage />} />
            <Route path={routes.products} element={<ProductsPage />} />
            <Route path={routes.history} element={<HistoryPage />} />
            <Route path={routes.automations} element={<AutomationsPage />} />
            <Route path={routes.settings} element={<SettingsPage />} />
            <Route path={routes.shopifyData} element={<ShopifyDataPage />} />
            <Route path={routes.plan} element={<PlanBillingPage />} />

            {demoPages.map(([path, title]) => (
              <Route
                key={path}
                path={path}
                element={<DemoPage title={title} />}
              />
            ))}

            <Route path="*" element={<Navigate to={routes.home} replace />} />
          </Routes>
        </s-query-container>
      </BrowserRouter>
    </>
  );
}
