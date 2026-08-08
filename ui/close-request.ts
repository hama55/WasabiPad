export interface CloseRequestPorts {
  saveForExit: () => Promise<boolean>;
  flushSettings: () => Promise<void>;
  onSettingsError: (error: unknown) => void | Promise<void>;
}

export async function canCloseWindow(ports: CloseRequestPorts): Promise<boolean> {
  if (!await ports.saveForExit()) return false;
  try {
    await ports.flushSettings();
    return true;
  } catch (error) {
    await ports.onSettingsError(error);
    return false;
  }
}
