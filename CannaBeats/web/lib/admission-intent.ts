export type AdmissionIntent = {
  actionId: string;
  code: string;
  name: string;
};

type AdmissionStorage = Pick<Storage,"getItem" | "setItem" | "removeItem">;

const keyFor = (code: string) => `cannabeats.admission.${code}`;
const ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validSavedIntent(value: Partial<AdmissionIntent>, code: string): value is AdmissionIntent {
  return value.code === code
    && typeof value.name === "string"
    && value.name.trim().length > 0
    && value.name === value.name.trim()
    && value.name.length <= 24
    && typeof value.actionId === "string"
    && ACTION_ID.test(value.actionId);
}

export function releaseExpiredAdmissionIntent({
  status,responseCode,code,storage,
}: {
  status: number;
  responseCode: unknown;
  code: string;
  storage: AdmissionStorage;
}) {
  if (status !== 410 || responseCode !== "expired") return false;
  clearAdmissionIntent(code,storage);
  return true;
}

export function durableAdmissionIntent({
  code,name,storage,createActionId,
}: {
  code: string;
  name: string;
  storage: AdmissionStorage;
  createActionId: () => string;
}): AdmissionIntent {
  const key = keyFor(code);
  const raw = storage.getItem(key);
  if (raw) {
    try {
      const saved = JSON.parse(raw) as Partial<AdmissionIntent>;
      if (validSavedIntent(saved,code)) return saved;
    } catch {}
    storage.removeItem(key);
  }
  const intent = { actionId: createActionId(),code,name };
  storage.setItem(key,JSON.stringify(intent));
  return intent;
}

export function clearAdmissionIntent(code: string, storage: AdmissionStorage) {
  storage.removeItem(keyFor(code));
}
