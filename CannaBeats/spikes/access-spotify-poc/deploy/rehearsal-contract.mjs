export function assertRestoredRollbackFloor({ liveAuthority, restoredAuthority }) {
  const liveFirstAdmittedAt = liveAuthority?.first_admitted_at;
  const restoredFirstAdmittedAt = restoredAuthority?.first_admitted_at;
  if (!Number.isSafeInteger(liveFirstAdmittedAt) || liveFirstAdmittedAt < 0) {
    throw new Error("Live rollback floor is missing or invalid.");
  }
  if (!Number.isSafeInteger(restoredFirstAdmittedAt) || restoredFirstAdmittedAt < 0) {
    throw new Error("Restored rollback floor is missing or invalid.");
  }
  if (restoredFirstAdmittedAt !== liveFirstAdmittedAt) {
    throw new Error("Restored rollback floor does not match the live authority floor.");
  }
  return restoredFirstAdmittedAt;
}
