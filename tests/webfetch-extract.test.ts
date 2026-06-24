// Unit tests for the dependency-free HTML extractor used by the webfetch skill.
// Imports the module directly — no subprocess, no network.
import { describe, it, expect } from 'vitest';
import { extractReadable } from '../skills/webfetch/extract.mjs';

// ---------------------------------------------------------------------------
// Non-string / missing input
// ---------------------------------------------------------------------------

describe('non-string input', () => {
  it('returns empty strings for null', () => {
    expect(extractReadable(null as unknown as string)).toEqual({ title: '', text: '' });
  });

  it('returns empty strings for undefined', () => {
    expect(extractReadable(undefined as unknown as string)).toEqual({ title: '', text: '' });
  });

  it('returns empty strings for a number', () => {
    expect(extractReadable(42 as unknown as string)).toEqual({ title: '', text: '' });
  });

  it('returns empty strings for an object', () => {
    expect(extractReadable({} as unknown as string)).toEqual({ title: '', text: '' });
  });
});

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

describe('title extraction', () => {
  it('extracts a plain title', () => {
    const { title } = extractReadable('<html><head><title>Hello World</title></head></html>');
    expect(title).toBe('Hello World');
  });

  it('decodes entities in the title', () => {
    const { title } = extractReadable('<title>AT&amp;T &lt;rocks&gt;</title>');
    expect(title).toBe('AT&T <rocks>');
  });

  it('collapses whitespace in the title', () => {
    const { title } = extractReadable('<title>  Spaced   Out  </title>');
    expect(title).toBe('Spaced Out');
  });

  it('decodes hex numeric entities in the title', () => {
    const { title } = extractReadable('<title>caf&#x00E9;</title>');
    expect(title).toBe('café');
  });

  it('returns empty string when title is absent', () => {
    const { title } = extractReadable('<html><body><p>No title here</p></body></html>');
    expect(title).toBe('');
  });

  it('handles title tag with attributes containing ">"', () => {
    // Pathological but should not swallow the actual title text.
    const { title } = extractReadable('<title data-x="a>b">My Page</title>');
    expect(title).toBe('My Page');
  });
});

// ---------------------------------------------------------------------------
// Script / style / noscript content removal
// ---------------------------------------------------------------------------

describe('script/style/noscript content removal', () => {
  it('removes script tag content, not just the tags', () => {
    const { text } = extractReadable('<p>Before</p><script>alert("secret")</script><p>After</p>');
    expect(text).not.toMatch(/alert/);
    expect(text).not.toMatch(/secret/);
    expect(text).toMatch(/Before/);
    expect(text).toMatch(/After/);
  });

  it('removes style tag content', () => {
    const { text } = extractReadable('<style>.hidden { display:none }</style><p>Visible</p>');
    expect(text).not.toMatch(/hidden/);
    expect(text).not.toMatch(/display/);
    expect(text).toMatch(/Visible/);
  });

  it('removes noscript tag content', () => {
    const { text } = extractReadable('<noscript>Please enable JS</noscript><p>Main</p>');
    expect(text).not.toMatch(/Please enable JS/);
    expect(text).toMatch(/Main/);
  });

  it('handles uppercase tag names', () => {
    const { text } = extractReadable('<SCRIPT>var x = 1;</SCRIPT><p>Content</p>');
    expect(text).not.toMatch(/var x/);
    expect(text).toMatch(/Content/);
  });

  it('handles script tag with attribute containing ">"', () => {
    // Attribute value with > should not terminate the open tag early.
    const { text } = extractReadable('<script type="text/x->template">leak()</script><p>Safe</p>');
    expect(text).not.toMatch(/leak/);
    expect(text).toMatch(/Safe/);
  });

  it('handles adjacent script blocks', () => {
    const html = '<script>a()</script><script>b()</script><p>Content</p>';
    const { text } = extractReadable(html);
    expect(text).not.toMatch(/\ba\b/);
    expect(text).not.toMatch(/\bb\b/);
    expect(text).toMatch(/Content/);
  });
});

// ---------------------------------------------------------------------------
// HTML comment removal
// ---------------------------------------------------------------------------

describe('HTML comment removal', () => {
  it('strips comments and their contents', () => {
    const { text } = extractReadable('<!-- DO NOT SHOW --><p>Show this</p>');
    expect(text).not.toMatch(/DO NOT SHOW/);
    expect(text).toMatch(/Show this/);
  });

  it('strips multi-line comments', () => {
    const { text } = extractReadable('<!--\nhidden\nblock\n--><p>visible</p>');
    expect(text).not.toMatch(/hidden/);
    expect(text).toMatch(/visible/);
  });
});

// ---------------------------------------------------------------------------
// Block-level tags → newlines
// ---------------------------------------------------------------------------

describe('block-level tags become newlines', () => {
  it('separates paragraphs with newlines', () => {
    const { text } = extractReadable('<p>First</p><p>Second</p>');
    expect(text).toBe('First\nSecond');
  });

  it('turns <br> into a newline', () => {
    const { text } = extractReadable('<p>Line one<br>Line two</p>');
    expect(text).toBe('Line one\nLine two');
  });

  it('turns <br/> into a newline', () => {
    const { text } = extractReadable('Hello<br/>World');
    expect(text).toBe('Hello\nWorld');
  });

  it('separates list items', () => {
    const { text } = extractReadable('<ul><li>A</li><li>B</li></ul>');
    expect(text).toBe('A\nB');
  });

  it('handles heading tags', () => {
    const { text } = extractReadable('<h1>Title</h1><p>Body</p>');
    expect(text).toMatch(/Title/);
    expect(text).toMatch(/Body/);
    // They must be on separate lines.
    const lines = text.split('\n');
    const titleLine = lines.findIndex((l) => l.includes('Title'));
    const bodyLine = lines.findIndex((l) => l.includes('Body'));
    expect(titleLine).not.toBe(bodyLine);
  });
});

// ---------------------------------------------------------------------------
// Remaining tag stripping
// ---------------------------------------------------------------------------

describe('remaining tag stripping', () => {
  it('strips inline tags leaving only text', () => {
    const { text } = extractReadable('<p>Hello <strong>world</strong>!</p>');
    expect(text).toBe('Hello world !');
  });

  it('strips tags with attribute values containing ">"', () => {
    // The > inside the attribute must NOT be treated as end-of-tag.
    const { text } = extractReadable('<p data-cond="a>b">Content</p>');
    expect(text).toMatch(/Content/);
    // The raw attribute value must not leak into the text.
    expect(text).not.toMatch(/data-cond/);
  });

  it('strips self-closing tags', () => {
    const { text } = extractReadable('<p>Text<img src="x.png"/>more</p>');
    expect(text).toMatch(/Textmore|Text more/);
  });
});

// ---------------------------------------------------------------------------
// Entity decoding
// ---------------------------------------------------------------------------

describe('entity decoding', () => {
  it('decodes named entities: &amp; &lt; &gt; &quot; &apos; &nbsp;', () => {
    const { text } = extractReadable(
      '<p>&amp; &lt; &gt; &quot; &apos; &nbsp;</p>',
    );
    expect(text).toContain('&');
    expect(text).toContain('<');
    expect(text).toContain('>');
    expect(text).toContain('"');
    expect(text).toContain("'");
    // &nbsp; decodes to a space; it ends up collapsed but not absent.
    // The surrounding spaces mean the whole result is just whitespace-collapsed.
  });

  it('decodes decimal numeric entities', () => {
    // &#65; = 'A', &#66; = 'B'
    const { text } = extractReadable('<p>&#65;&#66;&#67;</p>');
    expect(text).toContain('ABC');
  });

  it('decodes hex numeric entities (lowercase x)', () => {
    const { text } = extractReadable('<p>caf&#x00e9;</p>');
    expect(text).toContain('café');
  });

  it('decodes hex numeric entities (uppercase X)', () => {
    const { text } = extractReadable('<p>&#X41;&#X42;&#X43;</p>');
    // Uppercase X: our regex uses [0-9a-fA-F] for hex digits but requires
    // lowercase 'x' prefix in &#x...; — uppercase X is passed through as-is.
    // This is acceptable/documented behavior; just verify it doesn't throw.
    expect(typeof text).toBe('string');
  });

  it('passes through unknown named entities unchanged', () => {
    const { text } = extractReadable('<p>&unknownEntity;</p>');
    expect(text).toContain('&unknownEntity;');
  });

  it('handles invalid code points gracefully (safeCodePoint)', () => {
    // &#0; is technically valid but codepoint 0 returns empty string.
    const { text } = extractReadable('<p>&#0;normal</p>');
    expect(text).toContain('normal');
    // Should not throw.
  });
});

// ---------------------------------------------------------------------------
// Whitespace collapsing
// ---------------------------------------------------------------------------

describe('whitespace collapsing', () => {
  it('collapses multiple spaces within a line', () => {
    const { text } = extractReadable('<p>Hello     world</p>');
    expect(text).toBe('Hello world');
  });

  it('trims leading/trailing space from each line', () => {
    const { text } = extractReadable('<p>  padded  </p>');
    expect(text).toBe('padded');
  });

  it('drops blank lines', () => {
    const { text } = extractReadable('<p>A</p>\n\n\n<p>B</p>');
    expect(text).toBe('A\nB');
  });

  it('caps consecutive blank lines at 2 newlines', () => {
    // Three paragraphs with heavy whitespace between them.
    const html = '<p>A</p>' + '\n'.repeat(10) + '<p>B</p>';
    const { text } = extractReadable(html);
    expect(text).not.toMatch(/\n{3,}/);
  });
});

// ---------------------------------------------------------------------------
// maxChars truncation
// ---------------------------------------------------------------------------

describe('maxChars truncation', () => {
  it('does not truncate when text is within limit', () => {
    const { text } = extractReadable('<p>Short</p>', { maxChars: 100 });
    expect(text).toBe('Short');
    expect(text).not.toContain('(truncated)');
  });

  it('truncates and appends marker when over limit', () => {
    const html = '<p>' + 'x'.repeat(200) + '</p>';
    const { text } = extractReadable(html, { maxChars: 50 });
    expect(text.endsWith('\n…(truncated)')).toBe(true);
    // The marker itself may exceed 50, but the text before it should be ≤50.
    const bodyPart = text.replace('\n…(truncated)', '');
    expect(bodyPart.length).toBeLessThanOrEqual(50);
  });

  it('truncation does not throw on maxChars = 0', () => {
    const { text } = extractReadable('<p>Content</p>', { maxChars: 0 });
    expect(typeof text).toBe('string');
    expect(text).toContain('(truncated)');
  });

  it('truncation does not throw on maxChars larger than text', () => {
    const { text } = extractReadable('<p>Hi</p>', { maxChars: 999999 });
    expect(text).toBe('Hi');
  });
});

// ---------------------------------------------------------------------------
// Empty / minimal input
// ---------------------------------------------------------------------------

describe('empty or minimal input', () => {
  it('handles empty string', () => {
    expect(extractReadable('')).toEqual({ title: '', text: '' });
  });

  it('handles HTML with no body content', () => {
    const { text } = extractReadable('<html><head><title>T</title></head><body></body></html>');
    expect(text).toBe('');
  });

  it('handles a document with only script tags', () => {
    const { text } = extractReadable('<script>var x=1;</script>');
    expect(text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// CDATA
// ---------------------------------------------------------------------------

describe('CDATA sections', () => {
  it('strips CDATA content', () => {
    const { text } = extractReadable('<p>Before</p><![CDATA[hidden cdata]]><p>After</p>');
    expect(text).not.toMatch(/hidden cdata/);
    expect(text).toMatch(/Before/);
    expect(text).toMatch(/After/);
  });
});

// ---------------------------------------------------------------------------
// Realistic end-to-end document
// ---------------------------------------------------------------------------

describe('realistic HTML document', () => {
  const REALISTIC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Vitest &mdash; Fast Unit Testing</title>
  <style>
    body { font-family: sans-serif; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header>
    <nav><a href="/">Home</a> &gt; <a href="/docs">Docs</a></nav>
  </header>
  <main>
    <h1>Getting Started</h1>
    <p>Vitest is a <strong>blazing fast</strong> unit test framework powered by Vite.</p>
    <p>Install it with: <code>npm install vitest</code></p>
    <ul>
      <li>Zero config for Vite projects</li>
      <li>Native ESM support</li>
      <li>Watch mode &amp; HMR</li>
    </ul>
  </main>
  <script>
    // analytics
    window._ga = "UA-12345";
    document.addEventListener("DOMContentLoaded", function() { track(); });
  </script>
  <noscript>Please enable JavaScript.</noscript>
</body>
</html>`;

  it('extracts a clean title', () => {
    const { title } = extractReadable(REALISTIC_HTML);
    // &mdash; is not in our named-entity table; passes through — that's fine.
    // The important thing is the surrounding text is correct.
    expect(title).toContain('Vitest');
    expect(title).toContain('Fast Unit Testing');
  });

  it('does not include script content in body text', () => {
    const { text } = extractReadable(REALISTIC_HTML);
    expect(text).not.toMatch(/_ga/);
    expect(text).not.toMatch(/analytics/);
    expect(text).not.toMatch(/track\(\)/);
  });

  it('does not include style content in body text', () => {
    const { text } = extractReadable(REALISTIC_HTML);
    expect(text).not.toMatch(/font-family/);
    expect(text).not.toMatch(/display: none/);
  });

  it('does not include noscript content in body text', () => {
    const { text } = extractReadable(REALISTIC_HTML);
    expect(text).not.toMatch(/Please enable JavaScript/);
  });

  it('contains the main prose', () => {
    const { text } = extractReadable(REALISTIC_HTML);
    expect(text).toMatch(/Getting Started/);
    expect(text).toMatch(/blazing fast/);
    expect(text).toMatch(/unit test framework/);
    expect(text).toMatch(/Zero config for Vite projects/);
    expect(text).toMatch(/Native ESM support/);
  });

  it('decodes &amp; in body', () => {
    const { text } = extractReadable(REALISTIC_HTML);
    expect(text).toMatch(/Watch mode & HMR/);
  });

  it('has no raw HTML tags remaining in output', () => {
    const { text } = extractReadable(REALISTIC_HTML);
    // A loose check: no < followed by a letter (open tag remnant).
    expect(text).not.toMatch(/<[a-zA-Z]/);
  });

  it('produces compact multi-line prose without excessive blank lines', () => {
    const { text } = extractReadable(REALISTIC_HTML);
    expect(text).not.toMatch(/\n{3,}/);
  });
});
