export type AdmissionIntent = {
  actionId: string;
  code: string;
  name: string;
};

type AdmissionStorage = Pick<Storage,"getItem" | "setItem" | "removeItem">;

const keyFor = (code: string) => `cannabeats.admission.${code}`;

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
      if (saved.code === code && typeof saved.name === "string"
          && typeof saved.actionId === "string") {
        return saved as AdmissionIntent;
      }
    } catch {}
  }
  const intent = { actionId: createActionId(),code,name };
  storage.setItem(key,JSON.stringify(intent));
  return intent;
}

export function clearAdmissionIntent(code: string, storage: AdmissionStorage) {
  storage.removeItem(keyFor(code));
}
