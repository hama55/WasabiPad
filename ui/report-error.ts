export type ErrorReporter = (title: string, error: unknown) => void | Promise<unknown>;

export async function reportErrorSafely(reporter: ErrorReporter | undefined, title: string, error: unknown) {
  try {
    await reporter?.(title, error);
  } catch (reportError) {
    console.error(`${title}のエラーを表示できませんでした`, reportError);
  }
}
