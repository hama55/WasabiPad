const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function windowsFileNameError(name: string): string | null {
  if (!name || name === "." || name === "..") return "名前を入力してください";
  if (/[\u0000-\u001f<>:"/\\|?*]/.test(name)) {
    return '名前に使用できない文字が含まれています: < > : " / \\ | ? *';
  }
  if (/[ .]$/.test(name)) return "名前の末尾に空白またはピリオドは使用できません";
  if (WINDOWS_RESERVED_NAME.test(name)) return "Windowsの予約名は使用できません";
  return null;
}
