import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { routes } from "../../config/routes.js";

export default function HomeHeroSearch() {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSubmit = (event) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed) {
      navigate(`${routes.products}?search=${encodeURIComponent(trimmed)}`);
    } else {
      navigate(routes.products);
    }
  };

  return (
    <div className="home-hero-container">
      <s-heading level="1" class="home-hero-title">
        Good morning!
      </s-heading>

      <s-text class="home-hero-subtitle">
        What do you want to edit today?
      </s-text>

      <form onSubmit={handleSubmit} className="home-search-pill-form">
        <div
          className="home-search-pill"
          onClick={() => inputRef.current?.focus()}
        >
          <s-icon type="search" />

          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a collection, vendor, tag, or any product..."
            className="home-search-input"
            aria-label="Search products, collections, vendors, or tags"
          />

          <kbd className="home-search-kbd" aria-hidden="true">
            ⌘ K
          </kbd>
        </div>
      </form>
    </div>
  );
}

export { HomeHeroSearch };
