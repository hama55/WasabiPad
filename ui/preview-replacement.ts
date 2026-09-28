export function createPreviewReplacementLifecycle() {
  let replacingGeneration: number | null = null;
  let activeLabel: string | null = null;
  let manualSelectionGeneration = 0;

  return {
    beginManualSelection() {
      return ++manualSelectionGeneration;
    },
    isCurrentManualSelection(generation: number) {
      return manualSelectionGeneration === generation;
    },
    finishManualSelection(generation: number) {
      if (manualSelectionGeneration === generation) manualSelectionGeneration++;
    },
    invalidateManualSelection() {
      manualSelectionGeneration++;
    },
    isActive(label: string) {
      return activeLabel === label;
    },
    onAvailable(
      label: string,
      requestGeneration: number | null = null,
      invalidate?: () => void,
    ) {
      activeLabel = label;
      if (requestGeneration !== null && replacingGeneration !== requestGeneration) invalidate?.();
    },
    begin(requestGeneration: number) {
      replacingGeneration = requestGeneration;
    },
    finish(requestGeneration: number) {
      if (replacingGeneration === requestGeneration) replacingGeneration = null;
    },
    handleOpenResult(label: string | null, onSuperseded: () => void) {
      if (label !== null) return false;
      onSuperseded();
      return true;
    },
    onUnavailable(label: string, requestGeneration: number, invalidate: () => void) {
      if (activeLabel !== label) return false;
      activeLabel = null;
      if (replacingGeneration !== requestGeneration) invalidate();
      return true;
    },
  };
}

export function createExternalPreviewOutputLifecycle(cleanup: (path: string) => void) {
  let displayedOutputPath: string | null = null;

  return {
    displayedOutputPath() {
      return displayedOutputPath;
    },
    replaceDisplayedOutput(path: string | null, isCurrentRequest: () => boolean = () => true) {
      if (!isCurrentRequest()) return false;
      const retiredPath = displayedOutputPath;
      displayedOutputPath = path;
      if (retiredPath && retiredPath !== path) cleanup(retiredPath);
      return true;
    },
    discardGeneratedOutput(path: string, stillReferenced = false) {
      if (path !== displayedOutputPath && !stillReferenced) cleanup(path);
    },
  };
}
