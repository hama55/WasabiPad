export function lineNumberGroups(line: number): string[] {
  const digits = String(line);
  const firstGroupLength = digits.length % 3 || 3;
  const groups = [digits.slice(0, firstGroupLength)];
  for (let index = firstGroupLength; index < digits.length; index += 3) {
    groups.push(digits.slice(index, index + 3));
  }
  return groups;
}

export function lineNumberWidth(lineCount: number, measure: (digit: string) => number): number {
  const digits = String(lineCount).length;
  const digitWidth = Math.max(...Array.from("0123456789", measure));
  return digits * digitWidth + Math.floor((digits - 1) / 3) * 2;
}
