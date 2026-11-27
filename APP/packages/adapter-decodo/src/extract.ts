import { isSafePublicHttpUrl } from "../../core/src/index.ts";
import { MAX_JSON_LD_BLOCKS, readStructuredPage } from "./structured-page.ts";

const ENTITIES = new Map(Object.entries({
  amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " ", copy: "©", reg: "®", trade: "™",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•",
}));
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const RAW_TAGS = new Set(["script", "style", "title", "noscript"]);
const HIDDEN_TAGS = new Set(["svg", "template"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
const CHROME_TAGS = new Set(["nav", "aside", "form", "dialog"]);
const UI_ALT = /^(?:(?:a|an|the)\s+)?(?:(?:profile|user|account)\s+(?:photo|picture|image)|avatar|icon|logo|badge)\b/i;
const MAX_STRUCTURED_LINES = 32;
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "dialog", "alertdialog", "menu", "menubar", "search"]);
const SCOPE_TAGS = new Set(["html", "body", "main", "article", "header", "nav", "footer", "aside", "dialog", "form", "table"]);
const BLOCK_TAG = /^(?:address|article|aside|blockquote|br|dd|dialog|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)$/;
const HTML_START = /^<(?:!doctype\s+html\b|(?:html|head|body|title|meta|link|main|article|section|aside|dialog|div|p|h[1-6]|nav|header|footer|ul|ol|table|form|script|style|noscript|svg|template|a|span|strong|em|b|i)(?=[\s/>]))/i;
const ASSET_PATH = /\.(?:png|jpe?g|webp|avif|gif|svg|ico|css|m?js|cjs|woff2?|ttf|eot)$/i;
const SKIP_LINK = /^(?:skip to (?:(?:main|primary) )?content|jump to (?:(?:main|primary) )?content|ir al contenido(?: principal)?)(?:[.!?:]+)?$/i;
const MD_NAV_LINE = /^(?:(?:[-*+]|\d+\.)\s+)?(?:\[[^\]\n]+\]\((?:[^()\n]|\([^()\n]*\))*\)|<https?:\/\/[^<>\s]+>|[|/•·—–-])+(?:\s*(?:\[[^\]\n]+\]\((?:[^()\n]|\([^()\n]*\))*\)|<https?:\/\/[^<>\s]+>|[|/•·—–-]))*$/;
const EMPTY_ATTRS: ReadonlyMap<string, string> = new Map();

interface ElementFrame {
  readonly tag: string;
  readonly hidden: boolean;
  readonly chrome: boolean;
  readonly primary: boolean;
  readonly localLandmarks: boolean;
  readonly form: boolean;
  readonly dialog: boolean;
}

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

function isAssetUrl(url: string): boolean {
  try {
    return ASSET_PATH.test(decodeURIComponent(new URL(url).pathname));
  } catch { return true; }
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
      if (url === undefined || seen.has(url) || isAssetUrl(url)) return;
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

function hasHiddenFlag(fields: ReadonlyMap<string, string>): boolean {
  return fields.has("hidden") || fields.get("aria-hidden")?.trim().toLowerCase() === "true";
}

function hasModalFlag(fields: ReadonlyMap<string, string>): boolean {
  return fields.get("aria-modal")?.trim().toLowerCase() === "true";
}

function roleTokens(fields: ReadonlyMap<string, string>): string[] {
  return (fields.get("role") ?? "").toLowerCase().split(/\s+/);
}

function isSelfClosingTag(name: string, attrs: string): boolean {
  return VOID_TAGS.has(name) || /(?:^|[\s"'])\/\s*$/.test(attrs);
}

function closeFrame(stack: ElementFrame[], name: string): void {
  const scoped = !SCOPE_TAGS.has(name);
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.tag === name) {
      stack.length = i;
      return;
    }
    if (scoped && SCOPE_TAGS.has(stack[i]!.tag)) return;
  }
}

/** Extracts text only. This never renders or executes the scraped document. */
function scanMarkup(source: string, html: boolean, base: string, addStructuredLink: (value: string) => void) {
  const text: string[] = [];
  const main: string[] = [];
  const primary: string[] = [];
  const primaryLinks: string[] = [];
  const bodyLinks: string[] = [];
  const structuredText = new Map<string, string>();
  const structuredSubjects = new Set<string>();
  const metadata = new Map<string, string>();
  const hiddenTags: string[] = [];
  const stack: ElementFrame[] = [];
  let canonical: string | undefined;
  let title = "";
  let inHead = false;
  let passwordField = false;
  let passwordForm = false;
  let loginHeading = false;
  let loginAction = false;
  let heading: { name: string; parts: string[] } | undefined;
  let buttonParts: string[] | undefined;
  let jsonLdBlocks = 0;
  let cursor = 0;
  const addStructuredText = (raw: string, isSubjectName = false) => {
    if (structuredText.size >= MAX_STRUCTURED_LINES) return;
    const value = scalar(textFromHtml(raw), 400);
    if (!value) return;
    const key = value.toLowerCase();
    if (!structuredText.has(key)) structuredText.set(key, value);
    if (isSubjectName) structuredSubjects.add(key);
  };
  const tags = /<!--[\s\S]*?(?:-->|$)|<!doctype[^>]*>|<(https?:\/\/[^<>\s]+)>|<(\/?)([a-z][\w:-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/gi;
  const emit = (value: string) => {
    const current = stack.at(-1);
    if (current?.hidden) return;
    if (!html) text.push(value);
    if (html && !current?.chrome) {
      main.push(value);
      if (current?.primary) primary.push(value);
    }
    if (heading) heading.parts.push(value);
    if (buttonParts) buttonParts.push(value);
  };
  const emitText = (value: string) => {
    if (!hiddenTags.length && !inHead && value) {
      emit(html ? textFromHtml(value).replace(/\s+/g, " ") : value);
    }
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
      if (html && !hiddenTags.length && !stack.at(-1)?.chrome && match) {
        if (name === "title" && !title) {
          title = scalar(textFromHtml(source.slice(cursor, match.index)), 240);
        } else if (name === "script" && jsonLdBlocks < MAX_JSON_LD_BLOCKS) {
          const fields = attributes(attrs);
          if (fields.get("type")?.trim().toLowerCase() === "application/ld+json" &&
            !hasHiddenFlag(fields) && !hasModalFlag(fields) && !roleTokens(fields).some((role) => CHROME_ROLES.has(role))) {
            jsonLdBlocks++;
            readStructuredPage(source, cursor, match.index, addStructuredText, addStructuredLink);
          }
        }
      }
      cursor = tags.lastIndex = match ? end.lastIndex : source.length;
      continue;
    }
    if (HIDDEN_TAGS.has(name)) {
      if (closing) { if (hiddenTags.at(-1) === name) hiddenTags.pop(); }
      else if (!isSelfClosingTag(name, attrs)) hiddenTags.push(name);
      continue;
    }
    if (hiddenTags.length) continue;
    if (name === "head") { inHead = !closing; continue; }
    if (name === "body" && !closing) inHead = false;
    if (!html) continue;

    if (closing) {
      if (!inHead && /^h[1-6]$/.test(name) && heading?.name === name) {
        loginHeading ||= GATE_HEADING.test(scalar(heading.parts.join(""), 240));
        heading = undefined;
      }
      if (!inHead && name === "button" && buttonParts !== undefined) {
        loginAction ||= GATE_HEADING.test(scalar(buttonParts.join(""), 240));
        buttonParts = undefined;
      }
      if (!inHead && BLOCK_TAG.test(name)) emit("\n");
      if (!inHead) closeFrame(stack, name);
      continue;
    }

    const fields = attrs.trim() ? attributes(attrs) : EMPTY_ATTRS;
    if (!inHead && BLOCK_TAG.test(name)) emit("\n");

    const parent = stack.at(-1);
    const roles = roleTokens(fields);
    const isHidden = hasHiddenFlag(fields);
    const ariaModal = hasModalFlag(fields);
    const isChrome = CHROME_TAGS.has(name) || ariaModal || roles.some((role) => CHROME_ROLES.has(role)) ||
      ((name === "header" || name === "footer") && !parent?.localLandmarks);
    if (!inHead && !isSelfClosingTag(name, attrs)) {
      const isDialog = name === "dialog" || ariaModal || roles.includes("dialog") || roles.includes("alertdialog");
      const isPrimary = name === "main" || name === "article" || roles.includes("main");
      stack.push({
        tag: name,
        hidden: Boolean(parent?.hidden || isHidden),
        chrome: Boolean(parent?.chrome || isChrome || isHidden),
        primary: Boolean(parent?.primary || isPrimary),
        localLandmarks: Boolean(parent?.localLandmarks || isPrimary || name === "section"),
        form: Boolean(parent?.form || name === "form"),
        dialog: Boolean(parent?.dialog || isDialog),
      });
    } else if (!inHead && name === "img" && parent?.primary && !parent.chrome && !isHidden && !isChrome) {
      const caption = scalar(textFromHtml(fields.get("alt") ?? ""), 400);
      if (caption.length >= 25 && (caption.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 4 && !UI_ALT.test(caption)) {
        emit(`\n${caption}\n`);
      }
    }

    const current = stack.at(-1);
    if (!inHead && !current?.hidden) {
      if (/^h[1-6]$/.test(name)) {
        heading = { name, parts: [] };
        if (!current?.chrome && !isSelfClosingTag(name, attrs)) {
          const prefix = `\n${"#".repeat(Number(name[1]))} `;
          main.push(prefix);
          if (current?.primary) primary.push(prefix);
        }
      }
      if (name === "button" && (current?.form || current?.dialog)) buttonParts = [];
    }

    if (name === "meta") {
      const key = (fields.get("property") ?? fields.get("name"))?.toLowerCase();
      if (key && !metadata.has(key)) {
        const value = scalar(textFromHtml(fields.get("content") ?? ""), 400);
        if (value) metadata.set(key, value);
      }
    } else if (name === "link" && canonical === undefined) {
      if (fields.get("rel")?.toLowerCase().split(/\s+/).includes("canonical")) {
        canonical = safePageUrl(decodeEntities(fields.get("href") ?? "").trim(), base);
      }
    } else if (name === "a" && !inHead && !current?.chrome) {
      const href = decodeEntities(fields.get("href") ?? "").trim();
      if (href) (current?.primary ? primaryLinks : bodyLinks).push(href);
    } else if (!inHead && !current?.hidden && name === "input") {
      const type = fields.get("type")?.toLowerCase();
      if (type === "password") {
        passwordField = true;
        passwordForm ||= Boolean(current?.form || current?.dialog);
      } else if (type === "submit" && (current?.form || current?.dialog)) {
        loginAction ||= GATE_HEADING.test(textFromHtml(fields.get("value") ?? "").trim());
      }
    }
  }
  emitText(source.slice(cursor));
  return {
    rawMarkdown: html ? "" : escapeTagStarts(text.join("").replace(/[ \t]+(?=\n|$)/g, "").trim()),
    mainParts: main, primaryParts: primary, primaryLinks, bodyLinks, structuredText, structuredSubjects,
    passwordField, passwordForm, loginHeading, loginAction, canonical,
    title: clip(metadata.get("og:title") ?? metadata.get("title") ?? title, 240),
    description: metadata.get("description") ?? metadata.get("og:description") ?? metadata.get("twitter:description") ?? "",
  };
}

function cleanHtmlLines(parts: string[]): string {
  const result: string[] = [];
  const seen = new Set<string>();
  let previous = "";
  for (const rawLine of parts.join("").split("\n")) {
    const line = scalar(rawLine, Infinity);
    if (!line || /^#{1,6}$/.test(line) || SKIP_LINK.test(line)) continue;
    const key = line.toLowerCase();
    if (key === previous) continue;
    const words = key.split(" ").length;
    if ((key.length >= 18 || words >= 4) && seen.has(key)) continue;
    seen.add(key);
    previous = key;
    result.push(line);
  }
  return result.join("\n");
}

function markdownText(value: string): string {
  return textFromHtml(value.replace(/!?\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1"));
}

function isMarkdownSkipLine(line: string): boolean {
  const plain = scalar(markdownText(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")), Infinity);
  return SKIP_LINK.test(plain);
}

function isNavigationMarkdownBlock(block: string): boolean {
  const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) =>
    isMarkdownSkipLine(line) || MD_NAV_LINE.test(line) || GATE_HEADING.test(markdownText(line).trim()),
  );
}

function cleanMarkdown(source: string): { cleaned: string; repeatedBlocks: Set<string> } {
  const counts = new Map<string, number>();
  for (const rawBlock of source.split(/\n{2,}/)) {
    const key = rawBlock.replace(/\s+/g, " ").trim().toLowerCase();
    if (key.length >= 18 || key.includes(" ")) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeatedBlocks = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) repeatedBlocks.add(key);
  }

  const seenBlocks = new Set<string>();
  const seenLines = new Set<string>();
  const blocks: string[] = [];
  for (const rawBlock of source.split(/\n{2,}/)) {
    const lines: string[] = [];
    let prevLine = "";
    for (const rawLine of rawBlock.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed || isMarkdownSkipLine(trimmed)) continue;
      const lineKey = trimmed.replace(/\s+/g, " ").toLowerCase();
      if (lineKey === prevLine) continue;
      const words = lineKey.split(" ").length;
      if ((lineKey.length >= 18 || words >= 4) && seenLines.has(lineKey)) continue;
      seenLines.add(lineKey);
      prevLine = lineKey;
      lines.push(rawLine.replace(/[ \t]+$/, ""));
    }
    if (!lines.length) continue;
    const block = lines.join("\n");
    const blockKey = block.replace(/\s+/g, " ").trim().toLowerCase();
    if ((blockKey.length >= 18 || blockKey.includes(" ")) && seenBlocks.has(blockKey)) continue;
    seenBlocks.add(blockKey);
    blocks.push(block);
  }
  return { cleaned: blocks.join("\n\n"), repeatedBlocks };
}

export function extractPage(raw: string, base: string, target: string) {
  const source = raw.replace(/\r\n?/g, "\n").replace(CONTROLS, " ").trim();
  const html = HTML_START.test(source.replace(/^(?:<!--[\s\S]*?-->\s*)+/, ""));
  const { add, links } = linkCollector(target, base);
  const structuredLinks = linkCollector(target, base);
  // Keep raw script bytes and syntax for JSON-LD validation; visible text is normalized as it is extracted.
  const parsed = scanMarkup(html ? raw : source, html, base, structuredLinks.add);
  const { canonical, passwordField, passwordForm, loginHeading, loginAction } = parsed;
  const hasLoginForm = passwordForm && (loginHeading || GATE_HEADING.test(parsed.title));

  if (html) {
    for (const href of parsed.primaryLinks) add(href);
    for (const href of parsed.bodyLinks) add(href);
    for (const href of structuredLinks.links) add(href);
    const primaryCleaned = cleanHtmlLines(parsed.primaryParts);
    const mainCleaned = cleanHtmlLines(parsed.mainParts);
    const nonChrome = primaryCleaned.length >= 120 ? primaryCleaned : mainCleaned;
    const visibleLines = new Set<string>();
    for (const line of nonChrome.toLowerCase().split("\n")) {
      visibleLines.add(line);
      visibleLines.add(line.replace(/^#{1,6}\s+/, ""));
    }
    const titleIsGate = GATE_HEADING.test(parsed.title);
    const structured = [...parsed.structuredText].filter(([key]) => !visibleLines.has(key)).map(([, value]) => value).join("\n");
    const structuredCorroborated = (!titleIsGate || (!loginHeading && !loginAction)) && [...parsed.structuredSubjects].some((line) =>
      visibleLines.has(line) && !GATE_HEADING.test(line) && !GATE_COPY.test(line) && /\p{L}+\s+\p{L}+/u.test(line),
    );
    const cleaned = [nonChrome, structured].filter(Boolean).join("\n");
    const firstLine = cleaned.split("\n").find((line) => /[\p{L}\p{N}]/u.test(line)) ?? cleaned.split("\n", 1)[0] ?? "";
    const preview = parsed.description || scalar(firstLine.replace(/^#{1,6}\s+/, ""), 400);
    return {
      format: "html" as const, title: parsed.title, description: parsed.description, canonical, links,
      passwordField, passwordForm, loginAction, hasLoginForm, preview,
      content: clip(cleaned, 6000), contentLength: cleaned.length, main: nonChrome, structured, structuredCorroborated,
    };
  }

  const { cleaned, repeatedBlocks } = cleanMarkdown(parsed.rawMarkdown);
  for (const match of cleaned.matchAll(/(!?)\[[^\]\n]*\]\(\s*(https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+)\)|https?:\/\/[^\s<>"'\[\]]+/gi)) {
    if (match[1] === "!") continue;
    add(decodeEntities(match[2] ?? match[0].replace(/[.,;:!?]+$|\)+$/g, "").replace(/[.,;:!?]+$/, "")));
  }
  const [heading] = /^#\s+([^\n]+)/m.exec(cleaned)?.slice(1) ?? [];
  const hasPublicHeading = Array.from(cleaned.matchAll(/^ {0,3}#{1,6}[ \t]+([^\n]+)/gm))
    .some(([, value]) => !GATE_HEADING.test(markdownText(value!).trim()));
  // Standalone login links are often navigation on otherwise sparse profiles.
  const mainSource = hasPublicHeading ? cleaned.split("\n").filter((line) => {
    const trimmed = line.trim();
    return !/^\[[^\]\n]+\]\((?:[^()\n]|\([^()\n]*\))*\)$/.test(trimmed) || !GATE_HEADING.test(markdownText(trimmed));
  }).join("\n") : cleaned;
  const main = markdownText(mainSource).replace(/^\s{0,3}#{1,6}\s+/gm, "");
  const candidates = cleaned.split(/\n\s*\n/)
    .map((block) => block.replace(/^\s{0,3}#{1,6}[ \t]+[^\n]*(?:\n|$)/gm, "").trim())
    .filter(Boolean);
  const preferredParagraph = candidates.find((block) => {
    const blockKey = block.replace(/\s+/g, " ").trim().toLowerCase();
    return !isNavigationMarkdownBlock(block) && !repeatedBlocks.has(blockKey);
  }) ?? candidates.find((block) => !isNavigationMarkdownBlock(block)) ?? candidates[0];
  const preview = scalar(markdownText(preferredParagraph ?? ""), 400);
  const content = /[^\s#*`_~>-]/.test(main) ? cleaned : "";
  return {
    format: "markdown" as const, title: scalar(markdownText(heading ?? ""), 240), description: preview, preview,
    canonical, links, passwordField, passwordForm, loginAction, hasLoginForm,
    content: clip(content, 6000), contentLength: content.length, main, structured: "", structuredCorroborated: false,
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
  const lines = page.main.split("\n").map((line) => line.replace(/^#{1,6}\s+/, "").trim()).filter(Boolean);
  const hasVisibleGateHeading = lines.some((line) => GATE_HEADING.test(line));
  const substantive = lines.filter((line) => !GATE_HEADING.test(line) && !GATE_COPY.test(line));
  const substantiveLength = substantive.join(" ").length;
  const metadataLines = page.structured.split("\n").filter((line) => line && !GATE_HEADING.test(line) && !GATE_COPY.test(line));
  const titleIsGate = GATE_HEADING.test(page.title);
  const corroboratedLength = page.structuredCorroborated && (!titleIsGate || !page.passwordField) && !hasVisibleGateHeading
    ? metadataLines.join(" ").length : 0;
  const effectiveLength = substantiveLength + corroboratedLength;
  const hasSubstantiveProfile = !titleIsGate && !hasVisibleGateHeading && substantive.length >= 3 && substantiveLength >= 120 &&
    substantive.some((line) => line.split(/\s+/).length >= 5);
  if ((page.hasLoginForm || (page.passwordForm && page.loginAction)) && effectiveLength < 250 && !hasSubstantiveProfile) return true;
  if (!page.passwordField && !titleIsGate && !hasVisibleGateHeading) return false;
  if (effectiveLength >= 250 || hasSubstantiveProfile) return false;
  return !substantive.some((line) => line.split(/\s+/).length >= 5) && substantive.length < 2;
}
