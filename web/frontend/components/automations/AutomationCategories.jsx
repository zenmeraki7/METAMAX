import AutomationCategoryCard from "./AutomationCategoryCard.jsx";
import { automationCategories } from "../../data/automations.demo.js";

export default function AutomationCategories({ counts }) {
  return (
    <s-grid
      gridTemplateColumns="@container (inline-size > 768px) 'repeat(2, minmax(0, 1fr))', '1fr'"
      gap="base"
    >
      {automationCategories.map((category) => (
        <AutomationCategoryCard
          key={category.id}
          category={category}
          activeCount={counts?.[category.id] ?? 0}
        />
      ))}
    </s-grid>
  );
}

export { AutomationCategories };
