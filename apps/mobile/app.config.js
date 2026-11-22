// Adds the iOS Firebase config only when GoogleService-Info.plist is present locally.
// The plist is gitignored; CI builds without it and test harnesses inject it into the
// built .app (see .github/workflows/ios-build.yml and scripts/ios-testlab/).
const fs = require("fs");
const path = require("path");

module.exports = ({ config }) => {
  if (fs.existsSync(path.join(__dirname, "GoogleService-Info.plist"))) {
    config.ios = { ...config.ios, googleServicesFile: "./GoogleService-Info.plist" };
  }
  return config;
};
