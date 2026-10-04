import type { ChhApi } from '@chh/shared';

declare global {
  interface Window {
    chh: ChhApi;
  }
}
export {};
