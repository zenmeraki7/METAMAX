import { useId } from "react";

export default function HistoryActionMenu({ item, onView, onCopy, onRetry }) {
  const menuId = useId();
  const canRetry =
    Boolean(item?.retryable) &&
    (item?.status === "Failed" ||
      item?.status === "Cancelled" ||
      item?.status === "Expired") &&
    Boolean(onRetry);
  const items = [
    {
      content: "View operation details",
      icon: "view",
      onAction: () => {
        onView?.(item);
      },
    },
    {
      content: "Copy operation ID",
      icon: "duplicate",
      onAction: () => {
        onCopy?.(item.id);
      },
    },
  ];
  if (canRetry) {
    items.push({
      content: "Retry operation",
      icon: "undo",
      onAction: () => {
        onRetry?.(item);
      },
    });
  }
  return (
    <s-stack gap="base">
      <>
        <s-button
          variant="tertiary"
          accessibilityLabel={`Actions for ${item.title}`}
          icon="menu-horizontal"
          commandFor={menuId}
          onClick={(event) => event.stopPropagation()}
        ></s-button>
        <s-menu id={menuId} accessibilityLabel="Actions">
          {items.map((action) => (
            <s-button
              key={action.content}
              icon={action.icon}
              onClick={(event) => {
                event.stopPropagation();
                action.onAction();
              }}
            >
              {action.content}
            </s-button>
          ))}
        </s-menu>
      </>
    </s-stack>
  );
}
export { HistoryActionMenu };
