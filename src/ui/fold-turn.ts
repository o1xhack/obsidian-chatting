/**
 * Which of a finished turn's chat rows fold into one steps row above its
 * answer (`ChatContainer.foldTurn`): the tool steps, a text that only led
 * into a step ("Let me check."), and the changes row with its undo. An
 * `ask_user` question and the answer stay; in a turn without an answer
 * (an error, a pause, Stop) its texts stay too. A single step without
 * changes stays as it is: folding it saves nothing.
 */
export interface FoldableRow {
  type: string;
  turnId?: string;
}

export interface FoldPlan<T extends FoldableRow> {
  /** Where the steps row goes, in `rows` as they are: before the answer (else the first folded row). */
  at: number;
  steps: T[];
  changes?: T;
  /** The turn ended without an answer (an error, a pause, Stop): its texts stay, the row shows no check mark. */
  unanswered?: boolean;
}

const isStep = (row: FoldableRow): boolean => row.type === "tool-call" || row.type === "tool-result";

export function foldPlan<T extends FoldableRow>(rows: T[], turnId: string): FoldPlan<T> | null {
  const start = rows.findIndex((row) => row.type === "user" && row.turnId === turnId);
  if (start === -1) return null;
  const next = rows.findIndex((row, i) => i > start && row.type === "user" && !!row.turnId);
  const end = next === -1 ? rows.length : next;
  const steps: T[] = [];
  let changes: T | undefined;
  // A text that leads into a step folds only when an answer follows: without
  // one, those texts are all the model said.
  const leadsIntoStep = (i: number) => i + 1 < end && isStep(rows[i + 1]);
  let answered = false;
  for (let i = start + 1; i < end; i++) if (rows[i].type === "assistant" && !leadsIntoStep(i)) answered = true;
  for (let i = start + 1; i < end; i++) {
    const row = rows[i];
    if (isStep(row)) steps.push(row);
    else if (row.type === "changes") changes = row;
    else if (answered && row.type === "assistant" && leadsIntoStep(i)) steps.push(row);
  }
  if (!changes && steps.filter(isStep).length < 2) return null;
  const folded = new Set<T>(changes ? [...steps, changes] : steps);
  // Right above the answer, after what the user added while the turn ran;
  // without an answer (stopped) where the first folded row was.
  let at = -1;
  for (let i = end - 1; i > start; i--) {
    if (rows[i].type === "assistant" && !folded.has(rows[i])) {
      at = i;
      break;
    }
  }
  if (at === -1) at = rows.findIndex((row, i) => i > start && folded.has(row));
  return { at, steps, ...(changes ? { changes } : {}), ...(answered ? {} : { unanswered: true }) };
}
