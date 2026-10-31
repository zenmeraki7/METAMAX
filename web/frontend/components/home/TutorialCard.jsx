export default function TutorialCard({ onOpen }) {
  return (
    <s-section heading="Watch a quick tutorial">
      <s-stack gap="base">
        <s-image
          src="/metamax-tutorial-thumbnail.png"
          alt="METAMAX bulk editing tutorial"
          aspectRatio="710/257"
          loading="lazy"
        />
        <s-paragraph color="subdued">
          A step-by-step guide to bulk editing with Metamax.
        </s-paragraph>
        <s-button icon="play" onClick={onOpen}>
          Watch tutorial
        </s-button>
      </s-stack>
    </s-section>
  );
}
export { TutorialCard };
