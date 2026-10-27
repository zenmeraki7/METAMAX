import { HISTORY_TABS } from "../../data/history.demo.js";
const icons = {
  All: "layout-block",
  Edit: "edit",
  Export: "download",
  Import: "upload",
  File: "note",
};
export default function HistoryTabs({ active, onChange }) {
  const tabIds = HISTORY_TABS.map((t) => t.id);
  const activeIndex = Math.max(0, tabIds.indexOf(active));
  const handleKeyDown = (event) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const nextIndex = (activeIndex + 1) % tabIds.length;
      onChange(tabIds[nextIndex]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const prevIndex = (activeIndex - 1 + tabIds.length) % tabIds.length;
      onChange(tabIds[prevIndex]);
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(tabIds[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(tabIds[tabIds.length - 1]);
    }
  };
  return (
    <div
      role="tablist"
      aria-label="Operation category"
      onKeyDown={handleKeyDown}
    >
      <s-stack direction="inline" gap="base" alignItems="center">
        {HISTORY_TABS.map((tab) => {
          const Icon = icons[tab.id];
          const isSelected = active === tab.id;
          return (
            <s-button
              key={tab.id}
              role="tab"
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              variant={isSelected ? "primary" : "tertiary"}
              onClick={() => onChange(tab.id)}
              icon={Icon}
            >
              {tab.label}
            </s-button>
          );
        })}
      </s-stack>
    </div>
  );
}
