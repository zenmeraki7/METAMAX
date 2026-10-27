import { useState } from "react";
import { demoActivities } from "../data/dashboard.demo.js";

export default function useActivityFeed(activities = demoActivities, initialLimit = 5) {
  const [expanded, setExpanded] = useState(false);

  const list = activities || [];
  const hasMore = list.length > initialLimit;
  const visibleActivities = expanded ? list : list.slice(0, initialLimit);

  const toggleExpanded = () => setExpanded((prev) => !prev);

  return {
    visibleActivities,
    expanded,
    toggleExpanded,
    hasMore,
  };
}

export { useActivityFeed };
