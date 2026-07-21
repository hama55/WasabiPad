import { ask } from "@tauri-apps/plugin-dialog";

export function showError(message: string, error: unknown): Promise<boolean> {
  return ask(`${message}:\n${error}`, { title: "PetaPad", kind: "error" });
}
