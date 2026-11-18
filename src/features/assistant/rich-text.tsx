import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe rendering for assistant replies: paragraphs, bullet and
 * numbered lists, and **bold**. Everything is rendered as React text, never
 * as HTML, so model output cannot inject markup.
 */

export type Block =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join("\n") });
    paragraph = [];
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) {
      flush();
      const type = bullet ? "ul" : "ol";
      const item = (bullet ?? numbered)![1];
      const last = blocks.at(-1);
      if (last && last.type === type) last.items.push(item);
      else blocks.push({ type, items: [item] });
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line.replace(/^#{1,6}\s+/, ""));
    }
  }
  flush();
  return blocks;
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={i} className="font-semibold text-ink">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export function RichText({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2.5">
      {blocks.map((block, i) =>
        block.type === "p" ? (
          <p key={i} className="whitespace-pre-line">
            {inline(block.text)}
          </p>
        ) : block.type === "ul" ? (
          <ul key={i} className="list-disc space-y-1 pl-5 marker:text-ink-3">
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="list-decimal space-y-1 pl-5 marker:text-ink-3">
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}
