import { showMessage } from "./prompt";

export function showError(message: string, error: unknown): Promise<void> {
  return showMessage("エラー", `${message}:\n${error}`);
}
