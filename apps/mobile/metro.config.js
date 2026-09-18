// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(process.cwd());

// expo-sqlite's web adapter ships its SQLite engine as a WASM asset. Keep the
// native targets unchanged while allowing the shared Expo export to include
// the optional web bundle as well.
config.resolver.assetExts.push("wasm");

module.exports = config;
