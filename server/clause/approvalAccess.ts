import { fail } from "@agent-native/core/action";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { getProviderConfig } from "./config.js";

export function assertSignedInApprover(): void {
  requireApproverEmail();
}

/** The job store separately verifies ownership. The manager's name in the input is documentary. */
export function requirePolicyApprover(): string {
  const email = requireApproverEmail();
  const authDisabled = process.env.AUTH_DISABLED; // guard:allow-env-credential — framework demo authentication flag
  if (email === "dev@local.test" && getProviderConfig().awx.mode === "mock"
    && (process.env.NODE_ENV !== "production" || authDisabled === "true")) {
    return email;
  }

  const configured = process.env.CLAUSE_POLICY_APPROVER_EMAILS; // guard:allow-env-credential — deployment authorization policy
  const approvers = (configured ?? "").split(",").map((entry) => entry.trim().toLowerCase());
  if (!approvers.includes(email.toLowerCase())) {
    fail("This action requires a configured policy manager who owns the job.", { statusCode: 403 });
  }
  return email;
}

function requireApproverEmail(): string {
  const email = getRequestUserEmail();
  if (!email) fail("Sign in to approve this action.", { statusCode: 401 });
  return email;
}
