// 登録文字列 (右クリックから挿入する定型文) の永続化。
// エディタは「何を挿入するか」だけを知り、保存先は知らない。
import { getSetting, setSetting } from "./settings";

export function loadRegisteredStrings(): string[] {
  return getSetting("registeredStrings");
}

export function addRegisteredString(text: string): void {
  const strings = loadRegisteredStrings();
  if (!text || strings.includes(text)) return;
  setSetting("registeredStrings", [...strings, text]);
}

export function removeRegisteredString(text: string): void {
  setSetting("registeredStrings", loadRegisteredStrings().filter((item) => item !== text));
}

export function updateRegisteredString(previous: string, next: string): void {
  const strings = loadRegisteredStrings();
  if (!next || !strings.includes(previous) || strings.some((item) => item !== previous && item === next)) return;
  setSetting("registeredStrings", strings.map((item) => item === previous ? next : item));
}

export function registeredStringLabel(text: string): string {
  return text.replaceAll("\n", "↵").slice(0, 48) || "(空文字列)";
}
