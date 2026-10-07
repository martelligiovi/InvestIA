import { realpathSync, lstatSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export function resolveFrontendDistPath(): string {
  return fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
}

function isWithinRoot(root: string, filePath: string): boolean {
  const fromRoot = relative(root, filePath);
  return fromRoot === "" || (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function hasBuiltFrontend(root: string): boolean {
  try {
    if (!lstatSync(root).isDirectory()) return false;
    const canonicalRoot = realpathSync(root);
    const indexPath = realpathSync(resolve(root, "index.html"));
    return isWithinRoot(canonicalRoot, indexPath) && statSync(indexPath).isFile();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

function isReservedApiPath(pathname: string): boolean {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decodedPath === "/investigations" || decodedPath.startsWith("/investigations/");
}

function isSafeStaticPath(pathname: string, root: string): boolean {
  if (isReservedApiPath(pathname)) return false;
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalPath = realpathSync(resolve(root, `.${pathname}`));
    if (!isWithinRoot(canonicalRoot, canonicalPath)) return false;
    const canonicalFile = statSync(canonicalPath).isDirectory()
      ? realpathSync(resolve(canonicalPath, "index.html"))
      : canonicalPath;
    return isWithinRoot(canonicalRoot, canonicalFile) && statSync(canonicalFile).isFile();
  } catch {
    return false;
  }
}

export function registerFrontend(app: FastifyInstance, frontendDistPath = resolveFrontendDistPath()): boolean {
  const root = resolve(frontendDistPath);
  if (!hasBuiltFrontend(root)) return false;

  app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: "index.html",
    cacheControl: false,
    serveDotFiles: false,
    allowedPath: (pathname, staticRoot) =>
      typeof staticRoot === "string" && isSafeStaticPath(pathname, staticRoot),
    setHeaders: (response, filePath) => {
      response.setHeader(
        "Cache-Control",
        basename(filePath) === "index.html" ? "no-cache" : "public, max-age=3600",
      );
    },
  });
  return true;
}
