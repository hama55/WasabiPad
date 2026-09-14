import {
  WindowLayoutCoordinator,
  type WindowLayoutCoordinatorOptions,
} from "./window-layout";
import { bindLayoutResize, type LayoutResizeTarget } from "./window-layout-binding";

export interface WindowLayoutRuntime {
  coordinator: WindowLayoutCoordinator;
  dispose: () => void;
}

export function createWindowLayoutRuntime(
  target: LayoutResizeTarget,
  options: WindowLayoutCoordinatorOptions,
): WindowLayoutRuntime {
  const coordinator = new WindowLayoutCoordinator(options);
  const unbindResize = bindLayoutResize(target, () => coordinator.request());
  let disposed = false;
  return {
    coordinator,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unbindResize();
      coordinator.dispose();
    },
  };
}
