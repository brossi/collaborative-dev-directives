export type AdmissionIntent = {
  actionId: string;
  code: string;
  name: string;
};

type AdmissionStorage = Pick<Storage,"getItem" | "setItem" | "removeItem">;

const keyFor = (code: string) => `cannabeats.admission.${code}`;

function validSavedIntent(value: Partial<AdmissionIntent>, code: string): value is AdmissionIntent {
  return value.code === code
    && typeof value.name === "string"
    && value.name.trim().length > 0
    && value.name.length <= 24
    && typeof value.actionId === "string"
    && value.actionId.length > 0
    && value.actionId.length <= 128;
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
