const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// Watch shared prompts/validators and contract Zod schema from the repo root
config.watchFolders = [
  path.resolve(workspaceRoot, "shared"),
  path.resolve(workspaceRoot, "server/clause/contract"),
  path.resolve(workspaceRoot, "server/clause/expense"),
];

// Always resolve runtime packages (especially zod) from apps/mobile/node_modules
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  zod: path.resolve(projectRoot, "node_modules/zod"),
};

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "zod" || moduleName.startsWith("zod/")) {
    const mobileOriginContext = {
      ...context,
      originModulePath: path.join(projectRoot, "index.ts"),
    };
    return (defaultResolveRequest ?? context.resolveRequest)(
      mobileOriginContext,
      moduleName,
      platform,
    );
  }
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return resolve(context, moduleName, platform);
    } catch (e) {
      return resolve(context, moduleName.slice(0, -3), platform);
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
