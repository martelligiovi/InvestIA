export type AppRoute =
  | { readonly kind: "home" }
  | { readonly kind: "create" }
  | { readonly kind: "investigation"; readonly id: string }
  | { readonly kind: "not-found" };

const NOT_FOUND: AppRoute = { kind: "not-found" };

function decodeSafeSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    if (
      decoded.length === 0 ||
      decoded.length > 200 ||
      decoded === "." ||
      decoded === ".." ||
      /[\\/\u0000-\u001f\u007f]/u.test(decoded)
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

export function parseHashRoute(hash: string): AppRoute {
  if (hash === "" || hash === "#" || hash === "#/") return { kind: "home" };
  if (!hash.startsWith("#")) return NOT_FOUND;

  const routePath = hash.slice(1).split(/[?#]/u, 1)[0];
  if (routePath === "/") return { kind: "home" };
  if (!routePath.startsWith("/") || routePath.endsWith("/")) return NOT_FOUND;

  const segments = routePath.slice(1).split("/");
  const decodedSegments = segments.map(decodeSafeSegment);
  if (decodedSegments.some((segment) => segment === undefined)) return NOT_FOUND;
  const [section, id, extra] = decodedSegments;

  if (section === "nueva" && segments.length === 1) return { kind: "create" };
  if (section === "investigaciones" && id !== undefined && extra === undefined && segments.length === 2) {
    return { kind: "investigation", id };
  }
  return NOT_FOUND;
}

export function investigationHash(id: string): string {
  return `#/investigaciones/${encodeURIComponent(id)}`;
}
