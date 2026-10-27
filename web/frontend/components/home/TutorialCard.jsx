export default function TutorialCard({ onOpen }) {
  return (
    <s-section heading="Watch a quick tutorial">
      <s-link
        slot="secondary-actions"
        href="https://www.youtube.com"
        target="_blank"
        rel="noopener noreferrer"
      >
        <s-stack direction="inline" gap="extra-tight" alignItems="center">
          <span>Open in YouTube</span>
          <s-icon type="external" />
        </s-stack>
      </s-link>

      <s-stack gap="base">
        <button
          type="button"
          className="home-tutorial-banner"
          onClick={onOpen}
          aria-label="Watch the METAMAX bulk editing tutorial"
        >
          <div className="home-tutorial-banner__content">
            <div className="home-tutorial-banner__left">
              <div className="home-tutorial-banner__headline">
                Bulk edit products
                <br />
                in minutes
              </div>

              <div
                className="home-tutorial-banner__shopify-bag"
                aria-hidden="true"
              >
                <svg
                  width="36"
                  height="42"
                  viewBox="0 0 109 124"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M79.5 22.8c-.3-.2-.7-.3-1.1-.3-.4 0-14.7 0-14.7 0s-9.8-9.6-11.2-11c-1.4-1.4-4.1-2.2-6.2-2.2-2.2 0-4.1.8-5.5 2.2C39.4 12.9 29.6 22.5 29.6 22.5s-14.3 0-14.7 0c-.4 0-.8.1-1.1.3-.8.4-1.3 1.2-1.3 2.1 0 1.6 3.8 28.5 3.8 28.5s.4 3.7 1.5 5.5c1.1 1.8 3.3 2.4 3.3 2.4l1.3 54.3c0 2.2 1.8 4 4 4h54.8c2.2 0 4-1.8 4-4l1.3-54.3s2.2-.6 3.3-2.4c1.1-1.8 1.5-5.5 1.5-5.5s3.8-26.9 3.8-28.5c0-.9-.5-1.7-1.3-2.1z"
                    fill="#95BF47"
                  />
                  <path
                    d="M52.4 46.8c-8.9 0-13.6-4.5-13.6-4.5l2.2 11.2s4.2 3.6 11.4 3.6c7.3 0 11.3-4.5 11.3-10.8 0-11.5-16.7-13.4-16.7-19.8 0-4.7 3.5-7.2 8.3-7.2 4.4 0 7.8 2.3 7.8 2.3l-1.9-9.5s-3.7-1.4-7.8-1.4c-9.1 0-15 5.6-15 13.6 0 11.9 17 13.7 17 20.3 0 5-4.4 7.2-9.7 7.2z"
                    fill="#FFFFFF"
                  />
                </svg>
              </div>
            </div>

            <div
              className="home-tutorial-banner__play-circle"
              aria-hidden="true"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>

            <div
              className="home-tutorial-banner__mockup"
              aria-hidden="true"
            >
              <div className="home-mockup-table">
                <div className="home-mockup-row home-mockup-row--header">
                  <span className="home-mockup-check">✓</span>
                  <span className="home-mockup-header-text">Product</span>
                </div>

                <div className="home-mockup-row">
                  <span className="home-mockup-check">✓</span>
                  <span className="home-mockup-thumb home-mockup-thumb--shirt" />
                  <span className="home-mockup-text">Classic T-Shirt</span>
                </div>

                <div className="home-mockup-row">
                  <span className="home-mockup-check">✓</span>
                  <span className="home-mockup-thumb home-mockup-thumb--hoodie" />
                  <span className="home-mockup-text">Logo Hoodie</span>
                </div>

                <div className="home-mockup-row">
                  <span className="home-mockup-check">✓</span>
                  <span className="home-mockup-thumb home-mockup-thumb--cap" />
                  <span className="home-mockup-text">Sports Cap</span>
                </div>

                <div className="home-mockup-row">
                  <span className="home-mockup-check home-mockup-check--unchecked" />
                  <span className="home-mockup-thumb home-mockup-thumb--bottle" />
                  <span className="home-mockup-text">Water Bottle</span>
                </div>
              </div>
            </div>
          </div>
        </button>

        <s-stack gap="extra-tight">
          <s-text fontWeight="bold">2:36</s-text>
          <s-text color="subdued">
            A step-by-step guide to bulk editing with Metamax.
          </s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export { TutorialCard };
