import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import AppNavigation from "./components/layout/AppNavigation.jsx";
import SyncNotification from "./components/layout/SyncNotification.jsx";
import PageErrorBoundary from "./components/layout/PageErrorBoundary.jsx";
const HomePage = lazy(() => import("./pages/HomePage.jsx"));
const ProductsPage = lazy(() => import("./pages/ProductsPage.jsx"));
const HistoryPage = lazy(() => import("./pages/HistoryPage.jsx"));
const AutomationsPage = lazy(() => import("./pages/AutomationsPage.jsx"));
const SettingsPage = lazy(() => import("./pages/SettingsPage.jsx"));
const ShopifyDataPage = lazy(() => import("./pages/ShopifyDataPage.jsx"));
const PlanBillingPage = lazy(() => import("./pages/PlanBillingPage.jsx"));
const DemoPage = lazy(() => import("./pages/DemoPage.jsx"));
import { routes } from "./config/routes.js";

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
        <SyncNotification />

        <s-query-container>
          <PageErrorBoundary>
            <Suspense
              fallback={
                <s-page>
                  <s-section>
                    <s-spinner accessibilityLabel="Loading page" />
                  </s-section>
                </s-page>
              }
            >
              <Routes>
                <Route path={routes.home} element={<HomePage />} />
                <Route path={routes.products} element={<ProductsPage />} />
                <Route path={routes.history} element={<HistoryPage />} />
                <Route
                  path={routes.automations}
                  element={<AutomationsPage />}
                />
                <Route path={routes.settings} element={<SettingsPage />} />
                <Route
                  path={routes.shopifyData}
                  element={<ShopifyDataPage />}
                />
                <Route path={routes.plan} element={<PlanBillingPage />} />

                {demoPages.map(([path, title]) => (
                  <Route
                    key={path}
                    path={path}
                    element={<DemoPage title={title} />}
                  />
                ))}

                <Route
                  path="*"
                  element={<Navigate to={routes.home} replace />}
                />
              </Routes>
            </Suspense>
          </PageErrorBoundary>
        </s-query-container>
      </BrowserRouter>
    </>
  );
}
