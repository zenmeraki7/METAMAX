import ActivityRow from "./ActivityRow.jsx";
import { routes } from "../../config/routes.js";

export default function RecentActivity({ activities = [] }) {
  const visibleActivities = activities.slice(0, 4);

  return (
    <s-section heading="Recent activity">
      <s-link slot="secondary-actions" href={routes.history}>
        View all
      </s-link>

      {visibleActivities.length === 0 ? (
        <s-box paddingBlock="large">
          <s-text color="subdued">No recent activity.</s-text>
        </s-box>
      ) : (
        <s-stack gap="none">
          {visibleActivities.map((activity, index) => (
            <div key={activity.id}>
              {index > 0 && <s-divider />}
              <ActivityRow activity={activity} />
            </div>
          ))}
        </s-stack>
      )}
    </s-section>
  );
}

export { RecentActivity };
