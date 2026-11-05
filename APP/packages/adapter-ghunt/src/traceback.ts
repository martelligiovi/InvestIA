// Diagnostics are an allowlist, not a Python traceback transcription. Even valid
// identifiers and paths under site-packages can contain private input.
const HEADER = "Traceback (most recent call last):";
const SITE = "/opt/venv-ghunt/lib/python3.11/site-packages/";
const SOURCES = new Map([
  [`${SITE}ghunt/ghunt.py`, "ghunt/ghunt.py"],
  [`${SITE}ghunt/cli.py`, "ghunt/cli.py"],
  [`${SITE}ghunt/modules/email.py`, "ghunt/modules/email.py"],
  [`${SITE}httpx/_client.py`, "httpx/_client.py"],
  [`${SITE}httpx/_transports/default.py`, "httpx/_transports/default.py"],
  [`${SITE}httpcore/_async/connection_pool.py`, "httpcore/_async/connection_pool.py"],
  [`${SITE}httpcore/_async/connection.py`, "httpcore/_async/connection.py"],
  ["/usr/lib/python3.11/asyncio/runners.py", "asyncio/runners.py"],
  ["/usr/lib/python3.11/asyncio/base_events.py", "asyncio/base_events.py"],
]);
const FUNCTIONS = new Set([
  "<module>", "main", "run", "request", "send", "get", "post", "handle_async_request",
  "handle_request", "__aenter__", "__aexit__", "run_until_complete", "_run_once",
]);
const EXCEPTIONS = new Set([
  "Exception", "RuntimeError", "ValueError", "TypeError", "KeyError", "IndexError", "AttributeError",
  "ImportError", "ModuleNotFoundError", "OSError", "ConnectionError", "TimeoutError", "AssertionError",
  "httpx.HTTPError", "httpx.RequestError", "httpx.HTTPStatusError", "httpx.ConnectError", "httpx.ConnectTimeout",
  "httpx.ReadError", "httpx.ReadTimeout", "httpx.WriteError", "httpx.WriteTimeout", "httpx.PoolTimeout",
  "httpx.RemoteProtocolError", "httpcore.ConnectError", "httpcore.ConnectTimeout", "httpcore.ReadError",
  "httpcore.ReadTimeout", "httpcore.WriteError", "httpcore.WriteTimeout", "httpcore.PoolTimeout",
  "httpcore.RemoteProtocolError", "asyncio.exceptions.CancelledError",
]);
const MAX_FRAMES = 8;

/** Returns only fixed allowlisted strings and bounded line numbers, never output text. */
export function tracebackDetail(tail: string): string | undefined {
  // Strip complete CSI sequences after chunks have been reassembled.
  const clean = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const start = clean.lastIndexOf(HEADER);
  if (start < 0) return undefined;
  const frames: string[] = [];
  let exception = "unparsed traceback";
  for (const line of clean.slice(start + HEADER.length).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      const name = /^([A-Za-z_][\w.]*)((?::)|$)/.exec(line)?.[1];
      if (name && EXCEPTIONS.has(name)) exception = name;
      // The rest can be an arbitrary multiline exception message, not another exception.
      break;
    }
    const match = /^\s+File "([^"\r\n]+)", line ([1-9]\d{0,5}), in ([^\s]+)\s*$/.exec(line);
    if (!match || frames.length >= MAX_FRAMES) continue;
    const source = SOURCES.get(match[1]!);
    if (source && FUNCTIONS.has(match[3]!)) {
      const frame = `${source}:${match[2]} in ${match[3]}`;
      // Reserve room for the exception and exit detail as well as separators.
      if (frames.join("; ").length + frame.length + 2 <= 400) frames.push(frame);
    }
  }
  return exception + (frames.length ? `, frames [${frames.join("; ")}]` : "");
}
