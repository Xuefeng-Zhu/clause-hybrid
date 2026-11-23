import { agentNative } from "@agent-native/core/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

const reactRouterPlugins = reactRouter as unknown as () => any[];
const agentNativePlugins = agentNative as unknown as (
  options?: Parameters<typeof agentNative>[0],
) => any[];
/**
 * Production builds must never carry an App Check debug token, even if one sits in .env.local.
 * The dev-only code that reads it is compiled out (import.meta.env.DEV); this also drops the value
 * from the import.meta.env object Vite inlines into the client bundle.
 */
function stripAppCheckDebugToken() {
  return {
    name: "clause:strip-appcheck-debug-token",
    apply: "build" as const,
    configResolved(config: { env: Record<string, unknown> }) {
      delete config.env.VITE_APPCHECK_DEBUG_TOKEN;
    },
  };
}

export default defineConfig({
  optimizeDeps: {
    entries: [
      "app/entry.client.tsx",
      "app/root.tsx",
      "app/components/layout/{Layout,Sidebar}.tsx",
      "app/components/chat/ChatRouteContent.tsx",
      "app/routes/{home,chat.$threadId}.tsx",
    ],
  },
  plugins: [
    stripAppCheckDebugToken(),
    ...reactRouterPlugins(),
    ...agentNativePlugins({
      ssrStubs: ["shiki"],
    }),
  ],
});
