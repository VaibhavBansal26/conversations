import { describe, expect, it } from "vitest";
import { cleanPlainText, escapeHtml, htmlToText, sanitizeHtml, textToHtml } from "../src/util/html.js";
import { processContent } from "../src/services/messages.js";

describe("html sanitiser", () => {
  const cases: [string, string, (out: string) => void][] = [
    [
      "script tags and their content",
      "<p>Hi</p><script>alert(1)</script>",
      (o) => {
        expect(o).toBe("<p>Hi</p>");
      },
    ],
    [
      "onerror handlers",
      '<img src="https://x.test/a.png" onerror="alert(1)">',
      (o) => {
        expect(o).not.toMatch(/onerror/i);
        expect(o).toContain("<img");
      },
    ],
    [
      "javascript: hrefs",
      '<a href="javascript:alert(1)">x</a>',
      (o) => {
        expect(o).not.toMatch(/javascript/i);
      },
    ],
    [
      "obfuscated javascript: hrefs",
      '<a href="  JaVa\tScRiPt:alert(1)">x</a>',
      (o) => {
        expect(o).not.toMatch(/script:/i);
      },
    ],
    [
      "data: URIs in img",
      '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
      (o) => {
        expect(o).not.toContain("data:");
      },
    ],
    [
      "data: URIs in links",
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      (o) => {
        expect(o).not.toContain("data:");
      },
    ],
    [
      "inline style expressions",
      '<p style="width:expression(alert(1));background:url(javascript:alert(1))">x</p>',
      (o) => {
        expect(o).not.toMatch(/style|expression/i);
      },
    ],
    [
      "iframes, objects and forms",
      '<iframe src="https://evil.test"></iframe><object data="x"></object><form action="/x"><input></form>ok',
      (o) => {
        expect(o).toBe("ok");
      },
    ],
    [
      "nested malformed tags",
      "<p><b>bold<i>both</b>italic</i><div><<script>x</script>y",
      (o) => {
        expect(o).not.toMatch(/<script/i);
      },
    ],
    [
      "svg and math payloads",
      '<svg onload=alert(1)><circle/></svg><math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      (o) => {
        expect(o).not.toMatch(/svg|onload|javascript/i);
      },
    ],
    [
      "links get safe rel/target",
      '<a href="https://ok.test">ok</a>',
      (o) => {
        expect(o).toContain('rel="noopener noreferrer nofollow"');
        expect(o).toContain('target="_blank"');
      },
    ],
    [
      "mailto and tel survive",
      '<a href="mailto:a@b.test">m</a><a href="tel:+1555">t</a>',
      (o) => {
        expect(o).toContain("mailto:a@b.test");
        expect(o).toContain("tel:+1555");
      },
    ],
    [
      "event handlers on allowed tags",
      '<p onclick="x()" onmouseover="y()">p</p>',
      (o) => {
        expect(o).toBe("<p>p</p>");
      },
    ],
    [
      "protocol-relative URLs",
      '<a href="//evil.test/x">x</a>',
      (o) => {
        expect(o).not.toContain("//evil.test");
      },
    ],
    [
      "style tags",
      "<style>body{display:none}</style><p>x</p>",
      (o) => {
        expect(o).toBe("<p>x</p>");
      },
    ],
  ];
  it.each(cases)("%s", (_n, input, check) => check(sanitizeHtml(input)));

  it("keeps basic formatting", () => {
    expect(sanitizeHtml("<p>Hello <strong>world</strong><br>line</p><ul><li>a</li></ul>")).toBe("<p>Hello <strong>world</strong><br />line</p><ul><li>a</li></ul>");
  });
  it("converts html to text and text to html safely", () => {
    expect(htmlToText("<p>One</p><p>Two &amp; <b>three</b></p>")).toBe("One\nTwo & three");
    expect(textToHtml("a < b\n<script>")).toBe("a &lt; b<br>&lt;script&gt;");
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
    expect(cleanPlainText("a\u0000b\u0007c\r\nd")).toBe("abc\nd");
  });
  it("processContent: sms stays plain, dm/email become safe html with searchable text", () => {
    expect(processContent("sms", "<b>hi</b> there", "text")).toEqual({ content: "<b>hi</b> there", text: "<b>hi</b> there" });
    expect(processContent("sms", "<b>hi</b> there", "html").content).toBe("hi there");
    const dm = processContent("dm", "x <script>alert(1)</script> & y", "text");
    expect(dm.content).toBe("x &lt;script&gt;alert(1)&lt;/script&gt; &amp; y");
    expect(dm.text).toBe("x <script>alert(1)</script> & y");
    const em = processContent("email", '<p onclick="x">ok</p><script>1</script>', "html");
    expect(em.content).toBe("<p>ok</p>");
    expect(() => processContent("dm", "x".repeat(20001))).toThrow(/limited/);
  });
});
