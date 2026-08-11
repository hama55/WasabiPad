import { runAsyncBoundary } from "./async-boundary";
import { reportErrorSafely } from "./report-error";

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
  await reportErrorSafely(onError, title, error);
}
