import { useT } from "@agent-native/core/client/i18n";
import { useCustomKeyOnboardingAttemptLifecycle } from "@agent-native/core/client/onboarding/use-onboarding";
import { useActionQuery } from "@agent-native/core/client/use-action";
import { CORE_LABS } from "@agent-native/core/labs/core-labs";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import {
  AccountSettingsCard,
  useAgentSettingsTabs,
} from "@agent-native/toolkit/app/settings";
import {
  SettingsShell,
  SettingsShellSkeleton,
} from "@agent-native/toolkit/app/settings/shell";
import { Suspense } from "react";
import { useRouteLoaderData } from "react-router";

import { APP_TITLE } from "@/lib/app-config";
import type { loadChatAvailability } from "@/lib/chat-availability.server";

import changelog from "../../CHANGELOG.md?raw";

export function meta() {
  return [{ title: `Settings - ${APP_TITLE}` }];
}

// Chat has no app rows here: core Preferences owns the interface language.
export default function SettingsRoute() {
  const t = useT();
  const chatEnabled = useRouteLoaderData<typeof loadChatAvailability>(
    "root",
  )?.chatEnabled;
  const agentSettingsTabs = useAgentSettingsTabs();
  const { data: labStates } = useActionQuery("get-lab-states");
  const labs = CORE_LABS.filter((lab) =>
    Object.prototype.hasOwnProperty.call(labStates ?? {}, lab.key),
  );
  useCustomKeyOnboardingAttemptLifecycle();
  useSetPageTitle(t("settings.title"));

  return (
    <Suspense fallback={<SettingsShellSkeleton />}>
      <SettingsShell
        account={<AccountSettingsCard />}
        extraTabs={agentSettingsTabs}
        labs={labs}
        whatsNewMarkdown={changelog}
        agentToggle={chatEnabled === false ? null : undefined}
      />
    </Suspense>
  );
}
