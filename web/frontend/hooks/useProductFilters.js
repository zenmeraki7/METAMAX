import { useMemo, useState } from "react";

export default function useProductFilters(products) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();

    return products.filter((product) => {
      if (
        status !== "All" &&
        product.status !== status
      ) {
        return false;
      }

      if (!query) return true;

      const searchable = [
        product.title,
        product.vendor,
        product.category,
        product.productType,
        product.status,
      ];

      return searchable.some((value) =>
        String(value ?? "")
          .toLocaleLowerCase()
          .includes(query)
      );
    });
  }, [products, search, status]);

  return {
    search,
    setSearch,
    status,
    setStatus,
    filteredProducts,
  };
}

export { useProductFilters };
