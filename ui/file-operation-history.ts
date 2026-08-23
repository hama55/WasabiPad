export type FileOperation =
  | {
    kind: "move" | "copy";
    sourceRelPath: string;
    targetRelPath: string;
    targetRelDir: string;
    targetName: string;
    overwrite: boolean;
  }
  | {
    kind: "rename";
    sourceRelPath: string;
    targetRelPath: string;
  }
  | {
    kind: "delete";
    relPath: string;
    restoreRelPath: string | null;
  };

export class FileOperationHistory {
  private undoStack: FileOperation[][] = [];
  private redoStack: FileOperation[][] = [];
  private lastDropOperations: FileOperation[] | null = null;

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.lastDropOperations = null;
  }

  record(operations: FileOperation[], drop = false) {
    if (!operations.length) return;
    this.undoStack.push(operations);
    this.redoStack = [];
    this.lastDropOperations = drop ? operations : null;
  }

  takeUndo(): FileOperation[] | null {
    return this.undoStack.pop() ?? null;
  }

  restoreUndo(operations: FileOperation[]) {
    this.undoStack.push(operations);
  }

  completeUndo(operations: FileOperation[]) {
    const wasLastDrop = operations === this.lastDropOperations;
    this.redoStack.push(operations);
    if (wasLastDrop) this.lastDropOperations = null;
  }

  takeRedo(): FileOperation[] | null {
    return this.redoStack.pop() ?? null;
  }

  restoreRedo(operations: FileOperation[]) {
    this.redoStack.push(operations);
  }

  completeRedo(operations: FileOperation[]) {
    this.undoStack.push(operations);
    this.lastDropOperations = null;
  }

  lastDropUndo(): FileOperation[] | null {
    const operations = this.undoStack.at(-1);
    return operations && operations === this.lastDropOperations ? operations : null;
  }

}
