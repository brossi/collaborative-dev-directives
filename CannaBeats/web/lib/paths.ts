const configuredBasePath = process.env.NEXT_PUBLIC_CANNABEATS_BASE_PATH?.trim() ?? "";

export const CANNABEATS_BASE_PATH = configuredBasePath
  ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

export function cannabeatsPath(path = "/") {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${CANNABEATS_BASE_PATH}${suffix}`;
}
