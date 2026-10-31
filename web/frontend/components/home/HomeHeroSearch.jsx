import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { routes } from "../../config/routes.js";
export default function HomeHeroSearch() {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const navigate = useNavigate();
  useEffect(() => {
    const focusSearch = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  const submit = (event) => {
    event.preventDefault();
    const search = query.trim();
    navigate(
      search
        ? `${routes.products}?search=${encodeURIComponent(search)}`
        : routes.products,
    );
  };
  return (
    <s-section accessibilityLabel="Find products">
      <s-stack gap="base">
        <s-heading>What do you want to edit today?</s-heading>
        <form onSubmit={submit}>
          <s-grid
            gridTemplateColumns="minmax(0, 1fr) auto"
            gap="base"
            alignItems="end"
          >
            <s-search-field
              ref={inputRef}
              label="Search products"
              value={query}
              placeholder="Search title, vendor, type or handle"
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent?.isComposing)
                  submit(event);
              }}
            />
            <s-button onClick={submit}>Search</s-button>
          </s-grid>
        </form>
      </s-stack>
    </s-section>
  );
}
export { HomeHeroSearch };
