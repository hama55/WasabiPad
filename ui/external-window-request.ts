import type { Pos, WindowRequest } from "./api";

export interface ExternalWindowRequestPorts {
  open: (path: string, goto?: Pos) => void | Promise<boolean | void>;
  show: () => void | Promise<void>;
  focus: () => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
}

export async function processExternalWindowRequests(
  requests: WindowRequest[],
  ports: ExternalWindowRequestPorts,
) {
  for (const request of requests) {
    if (!request.path) continue;
    try {
      await ports.open(request.path, request.goto ?? undefined);
      await ports.show();
      await ports.focus();
    } catch (error) {
      await ports.onError(error);
    }
  }
}
