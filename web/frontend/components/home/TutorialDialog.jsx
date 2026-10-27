
export default function TutorialDialog({
  dialogRef,
  onClose,
}) {
  const videoUrl =
    import.meta.env.VITE_TUTORIAL_VIDEO_URL?.trim();

  return (
    <s-modal
      ref={dialogRef}
      heading="Getting started with METAMAX"
      size="large"
    >
      <s-stack gap="base">
        <s-paragraph>
          {videoUrl
            ? "Watch the tutorial to learn how to use METAMAX."
            : "The tutorial video has not been configured yet."}
        </s-paragraph>

        <img
          className="metamax-tutorial-preview"
          src="/metamax-tutorial-thumbnail.png"
          alt="METAMAX tutorial preview"
          loading="lazy"
          width="710"
          height="257"
        />
      </s-stack>

      <s-button
        slot="secondary-actions"
        variant="secondary"
        command="--hide"
        onClick={onClose}
      >
        Close
      </s-button>

      {videoUrl && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => {
            window.open(
              videoUrl,
              "_blank",
              "noopener,noreferrer"
            );
          }}
        >
          Open tutorial
        </s-button>
      )}
    </s-modal>
  );
}

export { TutorialDialog };
