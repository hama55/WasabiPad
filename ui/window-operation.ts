import { runAsyncBoundary } from "./async-boundary";

export type WindowErrorHandler = (title: string, error: unknown) => void | Promise<void>;

export function runWindowOperation(
  onError: WindowErrorHandler,
  title: string,
  operation: () => void | Promise<unknown>,
) {
  runAsyncBoundary(operation, (error) => reportWindowOperationError(onError, title, error));
}

export async function reportWindowOperationError(
  onError: WindowErrorHandler,
  title: string,
  error: unknown,
) {
  try {
    await onError(title, error);
  } catch (reportError) {
    console.error(`${title}のエラーを表示できませんでした`, reportError);
  }
}
