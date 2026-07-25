// 登録文字列 (右クリックから挿入する定型文) の永続化。
// エディタは「何を挿入するか」だけを知り、保存先は知らない。
const KEY = "registeredStrings";

export function loadRegisteredStrings(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function addRegisteredString(text: string): void {
  const strings = loadRegisteredStrings();
  if (!text || strings.includes(text)) return;
  localStorage.setItem(KEY, JSON.stringify([...strings, text]));
}

export function removeRegisteredString(text: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadRegisteredStrings().filter((item) => item !== text)));
}

export function registeredStringLabel(text: string): string {
  return text.replaceAll("\n", "↵").slice(0, 48) || "(空文字列)";
}
