export const EXTERNAL_PREFERENCE_READY = "wasabipad-external-preference-ready";
export const EXTERNAL_PREFERENCE_REQUEST = "wasabipad-external-preference-request";
export const EXTERNAL_PREFERENCE_RESULT = "wasabipad-external-preference-result";

export interface ExternalPreferenceRequest {
  type: typeof EXTERNAL_PREFERENCE_REQUEST;
  request_id: number;
  key: string;
  value?: boolean;
}

export interface ExternalPreferenceResult {
  type: typeof EXTERNAL_PREFERENCE_RESULT;
  request_id: number;
  key: string;
  value: boolean | null;
  reason: string | null;
}

export function isExternalPreferenceKey(key: unknown): key is string {
  return typeof key === "string" && /^[a-z0-9.-]{1,128}$/.test(key);
}

export function isExternalPreferenceRequest(data: unknown): data is ExternalPreferenceRequest {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const value = data as ExternalPreferenceRequest;
  return value.type === EXTERNAL_PREFERENCE_REQUEST
    && Number.isSafeInteger(value.request_id) && value.request_id >= 0
    && isExternalPreferenceKey(value.key)
    && (!Object.hasOwn(value, "value") || typeof value.value === "boolean");
}

export function isExternalPreferenceResult(data: unknown): data is ExternalPreferenceResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const value = data as ExternalPreferenceResult;
  return value.type === EXTERNAL_PREFERENCE_RESULT
    && Number.isSafeInteger(value.request_id) && value.request_id >= 0
    && isExternalPreferenceKey(value.key)
    && (value.value === null || typeof value.value === "boolean")
    && (value.reason === null || typeof value.reason === "string");
}

export function parseExternalPreviewPreferences(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => isExternalPreferenceKey(key) && typeof item === "boolean"));
}
