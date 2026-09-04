export {};

declare global {
  interface Window {
    barbarianDesktop?: {
      restartServer(): Promise<void>;
      applyPreferences(): Promise<void>;
    };
  }
}
