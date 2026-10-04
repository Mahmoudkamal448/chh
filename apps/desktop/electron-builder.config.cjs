// @ts-check
/**
 * Packaging, signing and publishing (electron-builder). Signing is driven entirely by environment
 * variables, so the same config makes signed release builds in CI and unsigned local builds:
 *
 *   macOS    CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application .p12), notarized when
 *            APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/
 *            APPLE_TEAM_ID are set.
 *   Windows  Azure Trusted Signing (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET plus
 *            AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE), or a
 *            certificate file (WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD). WIN_PUBLISHER_NAME must match
 *            the certificate's subject CN: the updater only installs updates signed by it.
 *   Linux    AppImage/deb/rpm; updates are verified with the SHA-512 in latest-linux.yml.
 *
 * See docs/RELEASING.md.
 */
const env = process.env;
const platform = env.CHH_TARGET_PLATFORM || process.platform;

const azure = !!(env.AZURE_SIGNING_ENDPOINT && env.AZURE_SIGNING_ACCOUNT && env.AZURE_SIGNING_PROFILE);
const winCert = !!(env.WIN_CSC_LINK || (platform === 'win32' && env.CSC_LINK));
const macCert = !!(env.CSC_LINK || env.CSC_NAME);
const notarize = !!((env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID));
const signed = platform === 'darwin' ? macCert : platform === 'win32' ? azure || winCert : false;
const publisherName = env.WIN_PUBLISHER_NAME || undefined;

const [owner, repo] = (env.CHH_RELEASE_REPO || env.GITHUB_REPOSITORY || 'mahmoudkamal448/chh').split('/');

if ((platform === 'darwin' || platform === 'win32') && !signed) {
  console.warn('[chh] no signing credentials found: building an UNSIGNED package (fine for local testing, not for release)');
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.chh.app',
  productName: 'chh',
  // Otherwise derived from the scoped package name (@chh/desktop).
  executableName: 'chh',
  copyright: 'Copyright © chh contributors',
  // Electron is hoisted to the workspace root, where electron-builder doesn't look for it.
  electronVersion: require('electron/package.json').version,
  directories: { buildResources: 'build', output: 'release/${version}' },
  files: ['out/**', 'package.json'],
  asarUnpack: ['**/*.node', '**/node_modules/node-pty/**'],
  npmRebuild: true,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Read at runtime: macOS only installs updates for signed apps.
  extraMetadata: { chhSigned: signed, desktopName: 'chh.desktop' },
  // Harden the packaged binary: no "run as plain Node", no NODE_OPTIONS/--inspect, and only the
  // integrity-checked app.asar is loaded.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // grantFileProtocolExtraPrivileges stays on: the UI is loaded with loadFile() from app.asar.
  },
  publish: [{ provider: 'github', owner, repo, releaseType: 'draft' }],

  mac: {
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      // The zip is what the updater downloads on macOS.
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // null skips signing entirely instead of picking a random identity from the keychain.
    ...(macCert ? {} : { identity: null }),
    notarize,
  },
  dmg: { writeUpdateInfo: false },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    ...(azure
      ? {
          azureSignOptions: {
            publisherName: publisherName ?? '',
            endpoint: env.AZURE_SIGNING_ENDPOINT,
            codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
            certificateProfileName: env.AZURE_SIGNING_PROFILE,
          },
        }
      : {}),
    ...(winCert && publisherName ? { signtoolOptions: { publisherName } } : {}),
    verifyUpdateCodeSignature: signed && !!publisherName,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    differentialPackage: true,
  },

  linux: {
    target: ['AppImage', 'deb', 'rpm'],
    category: 'Development',
    maintainer: 'chh contributors',
    synopsis: 'Free, cross-platform SSH client and terminal manager',
    executableName: 'chh',
    syncDesktopName: true,
  },
};
