import SettingsSection from "../components/settings/SettingsSection.jsx";
import SettingsSyncStatus from "../components/settings/SettingsSyncStatus.jsx";
import SettingsSyncNotice from "../components/settings/SettingsSyncNotice.jsx";
import SettingsHelp from "../components/settings/SettingsHelp.jsx";
import SettingsHelpDialog from "../components/settings/SettingsHelpDialog.jsx";
import useSettingsDashboard from "../hooks/useSettingsDashboard.js";
import { settingsSections } from "../data/settings.js";
import "../styles/settings.css";
export default function SettingsPage() {
  const dashboard = useSettingsDashboard();
  return (
    <s-page class="ms-page" heading="Settings">
      <s-link slot="breadcrumb-actions" href="/">
        Home
      </s-link>
      <s-button
        slot="secondary-actions"
        icon="book"
        onClick={() => dashboard.openHelp("documentation")}
      >
        View documentation
      </s-button>
      <s-paragraph>
        Manage how the app works with your store data and configure features.
      </s-paragraph>
      <s-stack gap="base">
        <s-stack class="ms-content" gap="base">
          <s-grid
            class="ms-layout"
            gridTemplateColumns="@container (inline-size > 900px) minmax(0, 1.72fr) minmax(0, 1fr), @container (inline-size > 600px) 1fr 1fr, 1fr"
            gap="base"
          >
            <s-stack class="ms-main-column" gap="base">
              {settingsSections.map((section) => (
                <SettingsSection key={section.id} section={section} />
              ))}
            </s-stack>

            <s-stack
              class="ms-sidebar"
              aria-label="Synchronization and help"
              gap="base"
            >
              <SettingsSyncStatus
                status={dashboard.status}
                lastFullSync={dashboard.lastFullSync}
                refreshing={dashboard.refreshing}
                onSync={dashboard.refreshAll}
                isDemo={dashboard.isDemo}
              />

              <SettingsSyncNotice />

              <SettingsHelp onOpenHelp={dashboard.openHelp} />
            </s-stack>
          </s-grid>
        </s-stack>

        <SettingsHelpDialog
          topicId={dashboard.helpTopic}
          onClose={dashboard.closeHelp}
        />

        {dashboard.message && (
          <s-stack class="local-toast" role="status" gap="base">
            {dashboard.message}
          </s-stack>
        )}
      </s-stack>
    </s-page>
  );
}
