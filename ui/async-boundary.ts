export function runAsyncBoundary(
  operation: () => void | Promise<unknown>,
  onError: (error: unknown) => void | Promise<void>,
) {
  try {
    void Promise.resolve(operation()).catch((error) => reportError(onError, error));
  } catch (error) {
    reportError(onError, error);
  }
}

function reportError(onError: (error: unknown) => void | Promise<void>, error: unknown) {
  try {
    void Promise.resolve(onError(error)).catch((reportError) => {
      console.error("非同期処理のエラー通知に失敗しました", reportError);
    });
  } catch (reportError) {
    console.error("非同期処理のエラー通知に失敗しました", reportError);
  }
}
