import {
  useCallback,
  useState,
} from "react";

export default function usePlanBilling() {
  const [dialog, setDialog] = useState(null);

  const choosePlan = useCallback((plan) => {
    setDialog({
      type: "plan",
      plan,
    });
  }, []);

  const comparePlans = useCallback(() => {
    setDialog({
      type: "compare",
    });
  }, []);

  const manageBilling = useCallback(() => {
    setDialog({
      type: "billing",
    });
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null);
  }, []);

  return {
    dialog,
    choosePlan,
    comparePlans,
    manageBilling,
    closeDialog,
  };
}
