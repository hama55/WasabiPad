export interface CloseRequestPorts {
  saveForExit: (onProceed: () => void | Promise<void>) => Promise<boolean>;
  flushSettings: () => Promise<void>;
  onSettingsError: (error: unknown) => void | Promise<void>;
}

export async function canCloseWindow(ports: CloseRequestPorts): Promise<boolean> {
  let flushError: unknown;
  try {
    return await ports.saveForExit(async () => {
      try {
        await ports.flushSettings();
      } catch (error) {
        flushError = error;
        await ports.onSettingsError(error);
        throw error;
      }
    });
  } catch (error) {
    if (error === flushError) return false;
    throw error;
  }
}
