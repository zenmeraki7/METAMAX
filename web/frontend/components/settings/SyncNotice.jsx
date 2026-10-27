import { useEffect, useRef } from "react";
export default function SyncNotice({ onDismiss }) {
  const bannerRef = useRef(null);
  useEffect(() => {
    const node = bannerRef.current;
    if (!node || !onDismiss) return;
    node.addEventListener("dismiss", onDismiss);
    return () => {
      node.removeEventListener("dismiss", onDismiss);
    };
  }, [onDismiss]);
  return (
    <s-banner
      ref={bannerRef}
      tone="info"
      heading="Your Shopify data is synced and stored securely"
      dismissible
      onDismiss={onDismiss}
    >
      <s-paragraph>
        To speed up searches and edits, the app maintains a synced copy of your
        Shopify data. If you made changes in Shopify that aren't appearing in
        the app, use the refresh buttons below to manually update your data.
      </s-paragraph>
    </s-banner>
  );
}
export { SyncNotice };
