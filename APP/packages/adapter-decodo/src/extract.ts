import { isSafePublicHttpUrl } from "../../core/src/index.ts";

const ENTITIES = new Map(Object.entries({
  amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " ", copy: "©", reg: "®", trade: "™",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•",
}));
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const RAW_TAGS = new Set(["script", "style", "title", "noscript"]);
const HIDDEN_TAGS = new Set(["svg", "template"]);
const CHROME_TAGS = new Set(["header", "nav", "footer", "aside", "form"]);
const BLOCK_TAG = /^(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)$/;
const HTML_START = /^<(?:!doctype\s+html\b|(?:html|head|body|title|meta|link|main|article|section|div|p|h[1-6]|nav|header|footer|ul|ol|table|form|script|style|noscript|svg|template|a|span|strong|em|b|i)(?=[\s/>]))/i;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (literal, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES.get(entity.toLowerCase()) ?? literal;
    const hexadecimal = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\uFFFD";
  });
}

function clip(value: string, limit: number): string {
  // Do not split a surrogate pair at a storage boundary.
  return value.length <= limit ? value : value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
}

export function scalar(value: string, limit: number): string {
  return clip(value.replace(CONTROLS, " ").replace(/\s+/g, " ").trim(), limit);
}

function escapeTagStarts(value: string): string {
  return value.replace(/<(?=[a-z!/?])/gi, "&lt;");
}

function textFromHtml(value: string): string {
  // Decode text, but do not turn encoded markup into literal HTML tags.
  return escapeTagStarts(decodeEntities(value));
}

export function safePageUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== "string" || !value || /[\s\\\x00-\x1f\x7f]/.test(value)) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !isSafePublicHttpUrl(value)) return undefined;
  try {
    const url = new URL(value, base);
    url.hash = "";
    return isSafePublicHttpUrl(url.href) ? url.href : undefined;
  } catch { return undefined; }
}

function linkCollector(target: string, base: string) {
  const links: string[] = [];
  const seen = new Set([safePageUrl(target), base]);
  let length = 0;
  return {
    links,
    add(value: string) {
      if (links.length === 10) return;
      const url = safePageUrl(value, base);
      if (url === undefined || seen.has(url)) return;
      const nextLength = length + (links.length ? 1 : 0) + url.length;
      if (nextLength > 1200) return;
      links.push(url);
      seen.add(url);
      length = nextLength;
    },
  };
}

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(/([^\s=<>/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!result.has(name)) result.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

/** Extracts text only. This never renders or executes the scraped document. */
function scanMarkup(source: string, html: boolean, base: string, addLink: (url: string) => void) {
  const text: string[] = [];
  const main: string[] = [];
  const metadata = new Map<string, string>();
  const hidden: string[] = [];
  const chrome: string[] = [];
  let canonical: string | undefined;
  let title = "";
  let inHead = false;
  let passwordField = false;
  let passwordForm = false;
  let loginHeading = false;
  let loginAction = false;
  let heading: { name: string; start: number } | undefined;
  let buttonStart: number | undefined;
  let cursor = 0;
  const tags = /<!--[\s\S]*?(?:-->|$)|<!doctype[^>]*>|<(https?:\/\/[^<>\s]+)>|<(\/?)([a-z][\w:-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/gi;
  const emit = (value: string) => {
    text.push(value);
    if (!chrome.length) main.push(value);
  };
  const emitText = (value: string) => {
    if (!hidden.length && !inHead) emit(html ? textFromHtml(value).replace(/\s+/g, " ") : value);
  };
  for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
    emitText(source.slice(cursor, tag.index));
    cursor = tags.lastIndex;
    const [, autolink, closing, rawName, attrs = ""] = tag;
    if (autolink !== undefined && !html) { emitText(autolink); continue; }
    if (rawName === undefined) continue; // Comment, doctype, or HTML text resembling an autolink.
    const name = rawName.toLowerCase();
    if (!closing && RAW_TAGS.has(name)) {
      const end = new RegExp(`</${name}\\s*>`, "gi");
      end.lastIndex = cursor;
      const match = end.exec(source);
      if (html && name === "title" && !title && !hidden.length && match) {
        title = scalar(textFromHtml(source.slice(cursor, match.index)), 240);
      }
      cursor = tags.lastIndex = match ? end.lastIndex : source.length;
      continue;
    }
    if (HIDDEN_TAGS.has(name)) {
      if (closing) { if (hidden.at(-1) === name) hidden.pop(); }
      else if (!attrs.endsWith("/")) hidden.push(name);
      continue;
    }
    if (hidden.length) continue;
    if (name === "head") { inHead = !closing; continue; }
    if (name === "body" && !closing) inHead = false;
    if (!html) continue;
    if (CHROME_TAGS.has(name)) {
      if (closing) { if (chrome.at(-1) === name) chrome.pop(); }
      else chrome.push(name);
    }
    if (!inHead && /^h[1-6]$/.test(name)) {
      if (!closing) heading = { name, start: text.length };
      else if (heading?.name === name) {
        loginHeading ||= GATE_HEADING.test(text.slice(heading.start).join("").trim());
        heading = undefined;
      }
    }
    if (!inHead && name === "button" && chrome.includes("form")) {
      if (!closing) buttonStart = text.length;
      else if (buttonStart !== undefined) {
        loginAction ||= GATE_HEADING.test(text.slice(buttonStart).join("").trim());
        buttonStart = undefined;
      }
    }
    if (!inHead && BLOCK_TAG.test(name)) emit("\n");
    if (closing) continue;
    if (name === "meta") {
      const fields = attributes(attrs);
      const key = (fields.get("property") ?? fields.get("name"))?.toLowerCase();
      if (key && !metadata.has(key)) {
        const value = scalar(textFromHtml(fields.get("content") ?? ""), 400);
        if (value) metadata.set(key, value);
      }
    } else if (name === "link" && canonical === undefined) {
      const fields = attributes(attrs);
      if (fields.get("rel")?.toLowerCase().split(/\s+/).includes("canonical")) {
        canonical = safePageUrl(decodeEntities(fields.get("href") ?? "").trim(), base);
      }
    } else if (name === "a" && !inHead) {
      addLink(decodeEntities(attributes(attrs).get("href") ?? "").trim());
    } else if (!inHead && name === "input") {
      const fields = attributes(attrs);
      const type = fields.get("type")?.toLowerCase();
      if (type === "password") {
        passwordField = true;
        passwordForm ||= chrome.includes("form");
      } else if (type === "submit" && chrome.includes("form")) {
        loginAction ||= GATE_HEADING.test(textFromHtml(fields.get("value") ?? "").trim());
      }
    }
  }
  emitText(source.slice(cursor));
  const lines = (parts: string[]) => parts.join("").split("\n").map((line) => scalar(line, Infinity)).filter(Boolean).join("\n");
  return {
    text: html ? lines(text) : escapeTagStarts(text.join("").replace(/[ \t]+(?=\n|$)/g, "").trim()),
    main: html ? lines(main) : "", passwordField, passwordForm, loginHeading, loginAction, canonical,
    title: clip(metadata.get("og:title") ?? metadata.get("title") ?? title, 240),
    description: metadata.get("description") ?? metadata.get("og:description") ?? "",
  };
}

function markdownText(value: string): string {
  return textFromHtml(value.replace(/!?\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1"));
}

export function extractPage(raw: string, base: string, target: string) {
  const source = raw.replace(/\r\n?/g, "\n").replace(CONTROLS, " ").trim();
  const html = HTML_START.test(source.replace(/^(?:<!--[\s\S]*?-->\s*)+/, ""));
  const { add, links } = linkCollector(target, base);
  const parsed = scanMarkup(source, html, base, add);
  const { text, canonical, passwordField, passwordForm, loginHeading, loginAction } = parsed;
  const hasLoginForm = passwordForm && (loginHeading || GATE_HEADING.test(parsed.title));
  if (html) {
    return {
      format: "html" as const, title: parsed.title, description: parsed.description, canonical, links, passwordField, passwordForm, loginAction, hasLoginForm,
      preview: scalar((parsed.main || text).split("\n", 1)[0] ?? "", 400),
      content: clip(text, 6000), contentLength: text.length, main: parsed.main,
    };
  }
  for (const match of text.matchAll(/\]\(\s*(https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+)|https?:\/\/[^\s<>"'\[\]]+/gi)) {
    add(decodeEntities(match[1] ?? match[0].replace(/[.,;:!?]+$|\)+$/g, "").replace(/[.,;:!?]+$/, "")));
  }
  const [heading] = /^#\s+([^\n]+)/m.exec(text)?.slice(1) ?? [];
  const hasPublicHeading = Array.from(text.matchAll(/^ {0,3}#{1,6}[ \t]+([^\n]+)/gm))
    .some(([, value]) => !GATE_HEADING.test(markdownText(value!).trim()));
  // Standalone login links are often navigation on otherwise sparse profiles.
  const mainSource = hasPublicHeading ? text.split("\n").filter((line) => {
    const trimmed = line.trim();
    return !/^\[[^\]\n]+\]\((?:[^()\n]|\([^()\n]*\))*\)$/.test(trimmed) || !GATE_HEADING.test(markdownText(trimmed));
  }).join("\n") : text;
  const main = markdownText(mainSource).replace(/^\s{0,3}#{1,6}\s+/gm, "");
  const paragraph = text.split(/\n\s*\n/).map((block) => block.replace(/^\s{0,3}#{1,6}[ \t]+[^\n]*(?:\n|$)/gm, "").trim()).find(Boolean);
  const preview = scalar(markdownText(paragraph ?? ""), 400);
  const content = /[^\s#*`_~>-]/.test(main) ? text : "";
  return {
    format: "markdown" as const, title: scalar(markdownText(heading ?? ""), 240), description: preview, preview,
    canonical, links, passwordField, passwordForm, loginAction, hasLoginForm, content: clip(content, 6000), contentLength: content.length, main,
  };
}

const GATE_HEADING = /^(?:auth(?:entication)?[ -]?wall\b|(?:please\s+)?(?:sign[ -]?in|log[ -]?in|sign[ -]?up|register|create (?:an?|your) account)(?=$|[\s!.:|–—-])|(?:join|welcome to) linkedin\b)/i;
const GATE_COPY = /^(?:email(?: address| or phone(?: number)?)?|phone(?: number)?|password|forgot (?:your )?password|remember me|new to linkedin|already (?:on linkedin|have an account)|join (?:now|today)|continue(?: with| as|$)|(?:or|show|hide)$|by (?:clicking|continuing|signing|joining)|make the most of your professional life|stay updated on your professional world|linkedin(?:\s*©|$)|(?:user agreement|privacy policy|cookie policy|terms of use)\b)/i;

export function isLoginGate(page: ReturnType<typeof extractPage>, ...urls: string[]): boolean {
  for (const url of urls) {
    const { pathname, hostname } = new URL(url);
    if (/^\/authwall(?:\/|$)/i.test(pathname)) return true;
    if (/(?:^|\.)linkedin\.com\.?$/.test(hostname) && /^\/(?:login|signup|uas\/login|checkpoint\/lg\/login)(?:\/|$)/i.test(pathname)) return true;
  }
  if (page.hasLoginForm) return true;
  const lines = page.main.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!page.passwordField && !GATE_HEADING.test(page.title) && !lines.some((line) => GATE_HEADING.test(line))) return false;
  // A navigation sign-in label is not a gate if there is separate page/profile content.
  const substantive = lines.filter((line) => !GATE_HEADING.test(line) && !GATE_COPY.test(line));
  if (page.passwordForm && page.loginAction && substantive.join(" ").length < 250) return true;
  return !substantive.some((line) => line.split(/\s+/).length >= 5) && substantive.length < 2;
}
