import { useAppBridge } from "@shopify/app-bridge-react";
import { useCallback } from "react";

export default function useShopifyToast() {
  const shopify = useAppBridge();

  const notify = useCallback(
    (text, options) => {
      if (!text) return;

      try {
        if (shopify?.toast?.show) {
          shopify.toast.show(text, options);
          return;
        }
        if (window.shopify?.toast?.show) {
          window.shopify.toast.show(text, options);
          return;
        }
      } catch (error) {
        console.warn("App Bridge toast failed:", error);
      }
      console.log(`[Shopify Toast] ${text}`);
    },
    [shopify]
  );

  return {
    notify,
    message: "",
    toast: "",
  };
}

export { useShopifyToast };
