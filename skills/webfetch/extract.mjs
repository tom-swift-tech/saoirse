// extract.mjs — dependency-free HTML → readable text for the webfetch skill.
//
// Crude but robust: drops non-content elements (script/style/etc.) wholesale,
// turns block boundaries into newlines, strips remaining tags, decodes common
// entities, and collapses whitespace. NOT a full Readability port — that needs
// jsdom, a heavy dependency the project avoids, and skills run as standalone
// subprocesses with no install step (so a skill must be zero-dep). This is good
// enough to feed a page's prose to the model.
//
// Contract (pinned — run.mjs depends on this signature):
//   extractReadable(html: string, { maxChars?: number }) -> { title, text }
//
// title is the <title> text (or ''); text is the collapsed readable body,
// truncated to maxChars with a "…(truncated)" marker when longer.

const NAMED_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function extractReadable(html, { maxChars = 8000 } = {}) {
  if (typeof html !== 'string') return { title: '', text: '' };

  const title = extractTitle(html);

  let text = html
    // CDATA sections (sometimes used inside SVG/script): drop contents.
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, ' ')
    // Non-content elements: remove tags AND their contents. The open-tag
    // pattern uses a quoted-attribute-aware match so attribute values
    // containing ">" don't terminate the tag prematurely. We run this twice
    // to catch the common browser pattern of adjacent/nested script blocks
    // (a second pass handles the rare case where a non-greedy stop on the
    // first </script> left another block behind).
    .replace(
      /<(script|style|noscript|template|svg|head)\b(?:[^"'>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(
      /<(script|style|noscript|template|svg|head)\b(?:[^"'>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1>/gi,
      ' ',
    )
    // Orphaned open tags for non-content elements (no matching close tag,
    // e.g. malformed HTML): drop to end-of-"tag" using quoted-attr-safe match.
    .replace(
      /<(script|style|noscript|template|svg|head)\b(?:[^"'>]|"[^"]*"|'[^']*')*>/gi,
      ' ',
    )
    // HTML comments.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Block-level close tags and <br> become line breaks for readability.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol|table)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip every remaining tag using a quoted-attribute-aware pattern so an
    // attribute value like onClick="a>b" doesn't swallow following text.
    .replace(/<(?:[^"'>]|"[^"]*"|'[^']*')*>/g, ' ');

  text = decodeEntities(text);

  // Per-line whitespace collapse, drop empty lines, cap consecutive blanks.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  // Truncate without throwing even if maxChars is 0 or larger than text.
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd() + '\n…(truncated)';
  }

  return { title, text };
}

function extractTitle(html) {
  // Quoted-attr-safe open-tag match so title attributes containing ">" are
  // handled correctly, then grab everything up to </title>.
  const m = /<title(?:[^"'>]|"[^"]*"|'[^']*')*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, (m) => NAMED_ENTITIES[m] ?? m);
}

function safeCodePoint(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}
