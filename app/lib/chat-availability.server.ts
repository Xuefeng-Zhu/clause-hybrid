import { redirect } from "react-router";

import { isContestMode } from "../../server/clause/contest-mode.js";
import { HOME_PATH } from "./chat-paths.js";

export function loadChatAvailability() {
  return { chatEnabled: !isContestMode() };
}

export function guardChatRoute() {
  return isContestMode() ? redirect(HOME_PATH) : null;
}
