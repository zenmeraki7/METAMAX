import {
  useCallback,
  useState,
} from "react";

export default function useAutomationDashboard() {
  const [noticeVisible, setNoticeVisible] =
    useState(true);

  const [dialog, setDialog] = useState(null);

  const dismissNotice = useCallback(() => {
    setNoticeVisible(false);
  }, []);

  const openHelp = useCallback(() => {
    setDialog({ type: "help" });
  }, []);

  const openTemplates = useCallback(() => {
    setDialog({ type: "templates" });
  }, []);

  const openTemplate = useCallback((template) => {
    setDialog({
      type: "template",
      template,
    });
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null);
  }, []);

  return {
    noticeVisible,
    dismissNotice,
    dialog,
    openHelp,
    openTemplates,
    openTemplate,
    closeDialog,
  };
}
