import useModalOverlay from "../../hooks/useModalOverlay.js";
import { useRef } from "react";
import { settingsHelpTopics } from "../../data/settings.js";
const documentation = {
  id: "documentation",
  title: "METAMAX documentation",
  content:
    "Use Shopify data to manage your catalog mirror, Automations to configure recurring edits and product rules, and History to inspect previous operations. Open the corresponding Settings section for additional controls.",
};
export default function SettingsHelpDialog({ topicId, onClose }) {
  const dialogRef = useRef(null);
  useModalOverlay(dialogRef, Boolean(topicId), onClose);
  const topic =
    topicId === "documentation"
      ? documentation
      : settingsHelpTopics.find((item) => item.id === topicId);
  return (
    <s-modal
      ref={dialogRef}
      id="settings-help"
      heading={topic?.title ?? "Help"}
    >
      {topic && (
        <>
          <s-paragraph>{topic.content}</s-paragraph>
        </>
      )}
      <s-button
        slot="secondary-actions"
        commandFor="settings-help"
        command="--hide"
      >
        Done
      </s-button>
    </s-modal>
  );
}
