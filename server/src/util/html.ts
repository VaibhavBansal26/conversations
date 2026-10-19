import sanitize from "sanitize-html";

const ALLOWED_TAGS = ["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "a", "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "img", "hr"];

/** Allow-list sanitiser for email/dm HTML. No inline styles, no scripts, no data: URIs, no event handlers. */
export function sanitizeHtml(html: string): string {
  return sanitize(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ["href", "title", "target", "rel"], img: ["src", "alt", "width", "height"] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (_tag, attribs) => ({ tagName: "a", attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }),
    },
  });
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const decodeEntities = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

export function htmlToText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-4]|blockquote)>/gi, "\n");
  const stripped = sanitize(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(stripped).replace(/\n{3,}/g, "\n\n").trim();
}

export const textToHtml = (text: string): string => escapeHtml(text).replace(/\r?\n/g, "<br>");

/** Strip control characters (except tab/newline) so SMS bodies stay printable. */
export const cleanPlainText = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\r\n/g, "\n");

export const snippet = (s: string, n = 120): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};
