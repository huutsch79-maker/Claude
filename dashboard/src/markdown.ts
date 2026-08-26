import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml"; // covers HTML too

// A small, explicit language set rather than highlight.js's full bundle —
// this is an internal ops tool's chat pane, not a general-purpose code
// viewer, and every language pulled in here is bundle size paid on every
// dashboard load.
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const highlighted = language ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
      const langClass = language ? ` language-${language}` : "";
      return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`;
    },
  },
});

/**
 * Only assistant replies go through this — user-typed text is rendered as
 * plain text (see ChatMessage.tsx), since interpreting a user's own input
 * as markdown they didn't ask to be formatted is more surprising than
 * useful. DOMPurify sanitizes marked's output before it's ever set as
 * innerHTML — defense in depth against the model ever echoing back
 * something that looks like markup it shouldn't.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}
