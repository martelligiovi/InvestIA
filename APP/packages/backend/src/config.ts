export interface BackendConfig {
  readonly databaseUrl: string;
  readonly host: string;
  /** Explicit Compose networking opt-in; omitted for native loopback-only startup. */
  readonly containerNetworking?: boolean;
  readonly port: number;
  readonly neo4jUri: string;
  readonly neo4jUsername: string;
  readonly neo4jPassword: string;
  readonly neo4jDatabase: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const LOOPBACK_NEO4J_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);

export function isAllowedBackendHost(host: string, containerNetworking = false): boolean {
  return LOOPBACK_HOSTS.has(host) || (containerNetworking === true && host === "0.0.0.0");
}

export function loadBackendConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BackendConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL must contain a PostgreSQL connection URL.");
  }
  try {
    const url = new URL(databaseUrl);
    if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || url.hostname.length === 0) throw new Error();
  } catch {
    throw new Error("DATABASE_URL must contain a valid PostgreSQL connection URL.");
  }

  const containerNetworking = env.INVESTIA_CONTAINER_NETWORKING === "true";
  const host = env.HOST ?? "127.0.0.1";
  if (!isAllowedBackendHost(host, containerNetworking)) {
    throw new Error("HOST must be a loopback address (or 0.0.0.0 with explicit container networking).");
  }
  const rawPort = env.PORT ?? "4317";
  if (!/^\d+$/.test(rawPort)) throw new Error("PORT must be an integer from 1 to 65535.");
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }

  const neo4jUri = env.NEO4J_URI?.trim();
  if (neo4jUri === undefined || neo4jUri.length === 0) {
    throw new Error("NEO4J_URI must contain a loopback Neo4j connection URL.");
  }
  try {
    const url = new URL(neo4jUri);
    if (
      !new Set(["neo4j:", "bolt:"]).has(url.protocol) ||
      !(LOOPBACK_NEO4J_HOSTS.has(url.hostname) || (containerNetworking && url.hostname === "neo4j")) ||
      url.username.length > 0 || url.password.length > 0
    ) throw new Error();
  } catch {
    throw new Error("NEO4J_URI must contain a loopback neo4j:// or bolt:// URL without embedded credentials (or the neo4j hostname with explicit container networking).");
  }

  const neo4jUsername = env.NEO4J_USERNAME?.trim();
  if (neo4jUsername === undefined || neo4jUsername.length === 0) {
    throw new Error("NEO4J_USERNAME must contain a Neo4j username.");
  }
  const neo4jPassword = env.NEO4J_PASSWORD;
  if (neo4jPassword === undefined || neo4jPassword.length === 0) {
    throw new Error("NEO4J_PASSWORD must contain a Neo4j password.");
  }
  const neo4jDatabase = env.NEO4J_DATABASE?.trim() ?? "neo4j";
  if (neo4jDatabase.length === 0) throw new Error("NEO4J_DATABASE must not be empty.");

  return {
    databaseUrl, host, port, neo4jUri, neo4jUsername, neo4jPassword, neo4jDatabase,
    ...(containerNetworking ? { containerNetworking: true } : {}),
  };
}
