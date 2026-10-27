import { useRef } from "react";

export default function useTutorialDialog() {
  const dialogRef = useRef(null);

  const open = () => {
    dialogRef.current?.showOverlay();
  };

  const close = () => {
    dialogRef.current?.hideOverlay();
  };

  return {
    dialogRef,
    open,
    close,
  };
}

export { useTutorialDialog };
