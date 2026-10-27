import AutomationCategoryCard from "./AutomationCategoryCard.jsx";
import { automationCategories } from "../../data/automations.demo.js";

export default function AutomationCategories({ counts }) {
  return (
    <div className="ma-categories-grid">
      {automationCategories.map((category) => (
        <AutomationCategoryCard
          key={category.id}
          category={category}
          activeCount={counts?.[category.id] ?? 0}
        />
      ))}
    </div>
  );
}

export { AutomationCategories };
