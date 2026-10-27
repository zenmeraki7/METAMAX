import { useState } from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "react-query";

export function ProductsCard() {
  const shopify = useAppBridge();
  const { t } = useTranslation();
  const [isPopulating, setIsPopulating] = useState(false);
  const productsCount = 5;

  const {
    data,
    refetch: refetchProductCount,
    isLoading: isLoadingCount,
  } = useQuery({
    queryKey: ["productCount"],
    queryFn: async () => {
      const response = await fetch("/api/products/count");
      return await response.json();
    },
    refetchOnWindowFocus: false,
  });

  const setPopulating = (flag) => {
    shopify.loading(flag);
    setIsPopulating(flag);
  };

  const handlePopulate = async () => {
    setPopulating(true);
    const response = await fetch("/api/products", { method: "POST" });

    if (response.ok) {
      await refetchProductCount();

      shopify.toast.show(
        t("ProductsCard.productsCreatedToast", { count: productsCount }),
      );
    } else {
      shopify.toast.show(t("ProductsCard.errorCreatingProductsToast"), {
        isError: true,
      });
    }

    setPopulating(false);
  };

  return (
    <s-section heading={t("ProductsCard.title")}>
      <s-stack gap="base">
        <s-paragraph>{t("ProductsCard.description")}</s-paragraph>
        <s-stack gap="small">
          <s-heading>{t("ProductsCard.totalProductsHeading")}</s-heading>
          <s-text type="strong">{isLoadingCount ? "-" : data?.count}</s-text>
        </s-stack>
        <s-button
          variant="primary"
          onClick={handlePopulate}
          loading={isPopulating}
          disabled={isPopulating}
        >
          {t("ProductsCard.populateProductsButton", { count: productsCount })}
        </s-button>
      </s-stack>
    </s-section>
  );
}
