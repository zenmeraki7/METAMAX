import { Component } from "react";
export default class PageErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <s-page heading="Page unavailable">
          <s-section>
            <s-banner tone="critical" heading="This page could not load">
              Reload the app to try again.
            </s-banner>
            <s-button onClick={() => window.location.reload()}>
              Reload app
            </s-button>
          </s-section>
        </s-page>
      );
    return this.props.children;
  }
}
