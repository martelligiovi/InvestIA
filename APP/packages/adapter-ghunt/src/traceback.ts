// Diagnostics are an allowlist, not a Python traceback transcription. Even valid
// identifiers and paths under site-packages can contain private input.
const HEADER = "Traceback (most recent call last):";
const SITE = "/opt/venv-ghunt/lib/python3.11/site-packages/";
const SOURCES = new Map([
  [`${SITE}ghunt/ghunt.py`, "ghunt/ghunt.py"],
  [`${SITE}ghunt/cli.py`, "ghunt/cli.py"],
  [`${SITE}ghunt/modules/email.py`, "ghunt/modules/email.py"],
  [`${SITE}ghunt/objects/apis.py`, "ghunt/objects/apis.py"],
  [`${SITE}ghunt/apis/__init__.py`, "ghunt/apis/__init__.py"],
  [`${SITE}ghunt/apis/accounts.py`, "ghunt/apis/accounts.py"],
  [`${SITE}ghunt/apis/calendar.py`, "ghunt/apis/calendar.py"],
  [`${SITE}ghunt/apis/clientauthconfig.py`, "ghunt/apis/clientauthconfig.py"],
  [`${SITE}ghunt/apis/digitalassetslinks.py`, "ghunt/apis/digitalassetslinks.py"],
  [`${SITE}ghunt/apis/drive.py`, "ghunt/apis/drive.py"],
  [`${SITE}ghunt/apis/fireconsolepa.py`, "ghunt/apis/fireconsolepa.py"],
  [`${SITE}ghunt/apis/geolocation.py`, "ghunt/apis/geolocation.py"],
  [`${SITE}ghunt/apis/identitytoolkit.py`, "ghunt/apis/identitytoolkit.py"],
  [`${SITE}ghunt/apis/mobilesdk.py`, "ghunt/apis/mobilesdk.py"],
  [`${SITE}ghunt/apis/peoplepa.py`, "ghunt/apis/peoplepa.py"],
  [`${SITE}ghunt/apis/playgames.py`, "ghunt/apis/playgames.py"],
  [`${SITE}ghunt/apis/playgateway.py`, "ghunt/apis/playgateway.py"],
  [`${SITE}ghunt/apis/vision.py`, "ghunt/apis/vision.py"],
  [`${SITE}ghunt/helpers/__init__.py`, "ghunt/helpers/__init__.py"],
  [`${SITE}ghunt/helpers/auth.py`, "ghunt/helpers/auth.py"],
  [`${SITE}ghunt/helpers/banner.py`, "ghunt/helpers/banner.py"],
  [`${SITE}ghunt/helpers/calendar.py`, "ghunt/helpers/calendar.py"],
  [`${SITE}ghunt/helpers/drive.py`, "ghunt/helpers/drive.py"],
  [`${SITE}ghunt/helpers/gcp.py`, "ghunt/helpers/gcp.py"],
  [`${SITE}ghunt/helpers/gmail.py`, "ghunt/helpers/gmail.py"],
  [`${SITE}ghunt/helpers/gmaps.py`, "ghunt/helpers/gmaps.py"],
  [`${SITE}ghunt/helpers/ia.py`, "ghunt/helpers/ia.py"],
  [`${SITE}ghunt/helpers/iam.py`, "ghunt/helpers/iam.py"],
  [`${SITE}ghunt/helpers/knowledge.py`, "ghunt/helpers/knowledge.py"],
  [`${SITE}ghunt/helpers/listener.py`, "ghunt/helpers/listener.py"],
  [`${SITE}ghunt/helpers/playgames.py`, "ghunt/helpers/playgames.py"],
  [`${SITE}ghunt/helpers/playstore.py`, "ghunt/helpers/playstore.py"],
  [`${SITE}ghunt/helpers/utils.py`, "ghunt/helpers/utils.py"],
  [`${SITE}httpx/_client.py`, "httpx/_client.py"],
  [`${SITE}httpx/_transports/default.py`, "httpx/_transports/default.py"],
  [`${SITE}httpcore/_async/connection_pool.py`, "httpcore/_async/connection_pool.py"],
  [`${SITE}httpcore/_async/connection.py`, "httpcore/_async/connection.py"],
  [`${SITE}httpcore/_async/http11.py`, "httpcore/_async/http11.py"],
  [`${SITE}httpcore/_async/http2.py`, "httpcore/_async/http2.py"],
  [`${SITE}httpcore/_async/http_proxy.py`, "httpcore/_async/http_proxy.py"],
  [`${SITE}httpcore/_async/socks_proxy.py`, "httpcore/_async/socks_proxy.py"],
  [`${SITE}httpcore/_async/interfaces.py`, "httpcore/_async/interfaces.py"],
  [`${SITE}httpcore/_backends/auto.py`, "httpcore/_backends/auto.py"],
  [`${SITE}httpcore/_backends/anyio.py`, "httpcore/_backends/anyio.py"],
  [`${SITE}anyio/_backends/_asyncio.py`, "anyio/_backends/_asyncio.py"],
  ["/usr/lib/python3.11/asyncio/runners.py", "asyncio/runners.py"],
  ["/usr/lib/python3.11/asyncio/base_events.py", "asyncio/base_events.py"],
]);
const FUNCTIONS = new Set([
  "<module>", "main", "run", "request", "send", "get", "post", "handle_async_request",
  "handle_request", "__aenter__", "__aexit__", "run_until_complete", "_run_once",
  // Functions defined by the pinned GHunt sources above.
  "__init__", "OAuthLogin", "get_calendar", "get_events", "get_brand", "list_statements",
  "get_file", "get_comments", "get_childs", "is_project_valid", "geolocate", "get_project_config",
  "test_iam_permissions", "get_webapp_dynamic_config", "people_lookup", "people", "get_profile",
  "get_played_games", "get_achievements", "search_player", "get_player_stats", "detect_faces",
  "android_master_auth", "android_oauth_app", "gen_osid", "gen_osids", "check_cookies", "check_osid",
  "check_osids", "check_master_token", "gen_cookies_and_osids", "check_and_gen", "auth_dialog", "load_and_auth",
  "show_banner", "fetch_all", "out", "get_users_from_file", "get_comments_from_file", "update_stats",
  "is_cloud_functions_panel_existing", "project_nb_from_key", "is_email_registered", "get_datetime", "get_reviews",
  "avg_location", "translate_confidence", "sanitize_location", "calculate_probable_location", "output",
  "detect_face", "test_all_permissions", "test_permission", "get_domain_of_service", "get_origin_of_key",
  "get_api_key", "get_gmaps_type_translation", "get_user_type_definition", "get_package_sig", "_set_response",
  "do_GET", "do_POST", "log_message", "get_player", "app_exists", "get_httpx_client", "oprint", "chunkify",
  "within_docker", "gen_sapisidhash", "inject_osid", "is_headers_syntax_good", "get_url_image_flathash",
  "is_default_profile_pic", "get_class_name", "get_datetime_utc", "ppnb", "parse_oauth_flow_response",
  "humanize_list", "unicode_patch", "show_version", "check_new_version", "hunt", "_load_api", "_load_endpoint",
  "_check_and_gen_authorization_token", "_query",
  // Common transport functions, also verified against the installed sources.
  "_connect", "connect_tcp", "connect_unix_socket", "connect_unix", "read", "write", "receive", "start_tls",
  "_send_request_headers", "_send_request_body", "_send_event", "_receive_response_headers", "_receive_response_body",
  "_receive_event", "_receive_response", "_receive_stream_event", "_receive_events", "_read_incoming_data", "_write_outgoing_data",
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
    if (!match) continue;
    const source = SOURCES.get(match[1]!);
    if (source && FUNCTIONS.has(match[3]!)) {
      const frame = `${source}:${match[2]} in ${match[3]}`;
      frames.push(frame);
      // Keep the nearest frames while reserving room for exception and exit detail.
      while (frames.length > MAX_FRAMES || frames.join("; ").length > 400) frames.shift();
    }
  }
  return exception + (frames.length ? `, frames [${frames.join("; ")}]` : "");
}
