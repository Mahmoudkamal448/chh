import type { CyApi } from '@cy-ssh/shared';

declare global {
  interface Window {
    cy: CyApi;
  }
}
export {};
