import {
  useHeaderTitle,
  useHeaderActions,
} from "@agent-native/toolkit/app-shell";
import { AgentToggleButton } from "@agent-native/toolkit/app/chat";

import { MobileAppBar } from "./MobileAppBar";

interface HeaderProps {
  chatEnabled: boolean;
  onOpenMobileSidebar: () => void;
}

export function Header({ chatEnabled, onOpenMobileSidebar }: HeaderProps) {
  const title = useHeaderTitle();
  const actions = useHeaderActions();

  return (
    <MobileAppBar
      className="md:ps-4"
      onOpenNavigation={onOpenMobileSidebar}
      title={title}
      actions={
        <>
          {actions}
          {chatEnabled ? <AgentToggleButton /> : null}
        </>
      }
    />
  );
}
