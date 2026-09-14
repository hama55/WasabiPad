import type { promptFields } from "./prompt";
import { addRegisteredString, updateRegisteredString } from "./registered-strings";
import { flushSettings } from "./settings";

export function promptRegisteredString(
  prompt: typeof promptFields,
  title: string,
  initial = "",
): Promise<string | null> {
  return prompt(title, [{
    label: "文字列",
    value: initial,
    multiline: true,
    validate: (value) => value.trim() ? null : "文字列を入力してください",
  }]).then((values) => values?.[0] ?? null);
}

export async function promptAndSaveRegisteredString(
  prompt: typeof promptFields,
  current?: string,
  initial = current ?? "",
): Promise<void> {
  const value = await promptRegisteredString(
    prompt,
    current === undefined ? "登録文字列を登録" : "登録文字列を編集",
    initial,
  );
  if (value === null) return;
  if (current === undefined) addRegisteredString(value);
  else updateRegisteredString(current, value);
  await flushSettings();
}
