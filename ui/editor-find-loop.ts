import type * as api from "./api";
import type { Pos } from "./api";

export async function findForward(
  client: Pick<api.DocumentClient, "findStep">,
  pattern: string,
  from: Pos,
  matchCase: boolean,
  budget: number,
  isCurrent: () => boolean,
  onProgress: (cursor: api.FindCursor) => void,
): Promise<api.FindOutcome | null> {
  let cursor: api.FindCursor | undefined;
  for (;;) {
    const outcome = await client.findStep(pattern, from, matchCase, cursor, budget);
    if (!isCurrent()) return null;
    if (outcome.kind !== "More") return outcome;
    cursor = outcome.cursor;
    onProgress(cursor);
  }
}
