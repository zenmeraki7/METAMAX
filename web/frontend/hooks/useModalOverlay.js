import { useEffect, useRef } from "react";

// Native lifecycle listeners also support the event names used by CDN overlays.
export default function useModalOverlay(modalRef, visible, onClose) {
  const closeCallback = useRef(onClose);
  const shown = useRef(false);
  closeCallback.current = onClose;

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const handleShow = () => {
      shown.current = true;
    };
    const handleHide = () => {
      shown.current = false;
      closeCallback.current?.();
    };
    modal.addEventListener("show", handleShow);
    modal.addEventListener("hide", handleHide);
    return () => {
      modal.removeEventListener("show", handleShow);
      modal.removeEventListener("hide", handleHide);
    };
  }, [modalRef]);

  useEffect(() => {
    if (visible === undefined) return;
    let cancelled = false;
    customElements.whenDefined("s-modal").then(() => {
      const modal = modalRef.current;
      if (cancelled || !modal) return;
      if (visible && !shown.current) {
        shown.current = true;
        modal.showOverlay();
      } else if (!visible && shown.current) {
        modal.hideOverlay();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [modalRef, visible]);
}
