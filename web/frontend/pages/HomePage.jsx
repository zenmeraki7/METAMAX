import MetricsGrid from "../components/home/MetricsGrid.jsx";
import HomeHeroSearch from "../components/home/HomeHeroSearch.jsx";
import QuickActions from "../components/home/QuickActions.jsx";
import TutorialCard from "../components/home/TutorialCard.jsx";
import TutorialDialog from "../components/home/TutorialDialog.jsx";
import RecentActivity from "../components/home/RecentActivity.jsx";
import useTutorialDialog from "../hooks/useTutorialDialog.js";
import { demoMetrics, demoActivities } from "../data/dashboard.demo.js";
import { routes } from "../config/routes.js";
import "../dashboard.css";

export default function HomePage() {
  const tutorial = useTutorialDialog();

  return (
    <>
      <s-page heading="Home" inlineSize="large">
        <s-button
          slot="secondary-actions"
          icon="menu-horizontal"
          commandFor="home-page-menu"
          accessibilityLabel="More actions"
        >
          More actions
        </s-button>
        <s-menu id="home-page-menu" accessibilityLabel="Home actions">
          <s-button href={routes.support}>Help & Support</s-button>
          <s-button href={routes.settings}>Settings</s-button>
        </s-menu>

        <s-stack gap="base">
          <MetricsGrid metrics={demoMetrics} />

          <HomeHeroSearch />

          <QuickActions />

          <s-grid
            gridTemplateColumns="@container (inline-size > 860px) minmax(0, 1.35fr) minmax(0, 1fr), 1fr"
            gap="base"
          >
            <TutorialCard onOpen={tutorial.open} />
            <RecentActivity activities={demoActivities} />
          </s-grid>
        </s-stack>
      </s-page>

      <TutorialDialog
        dialogRef={tutorial.dialogRef}
        onClose={tutorial.close}
      />
    </>
  );
}

export { HomePage };
