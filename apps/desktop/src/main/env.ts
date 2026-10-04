/** Flags read once at startup. */
export const TEST_MODE = process.env.CHH_TEST === '1';
/** Overrides the user-data dir (used by E2E tests and for portable installs). */
export const USER_DATA_OVERRIDE = process.env.CHH_USER_DATA || null;
/**
 * Lets the app start when the OS has no usable keychain (Linux without a secret service)
 * without showing the confirmation dialog. Intended for CI/E2E only.
 */
export const ALLOW_WEAK_KEYSTORE = process.env.CHH_ALLOW_WEAK_KEYSTORE === '1';
