import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { markdownComponents } from "./markdownComponents";
import "katex/dist/katex.min.css";

/**
 * Normalize common LaTeX delimiters Grok / LLMs emit into remark-math form.
 * - \[ ... \]  →  $$ ... $$
 * - \( ... \)  →  $ ... $
 *
 * Protects fenced code (``` / ~~~ / 4+ backticks), unclosed fences to EOF,
 * and inline code spans so literal `\(x\)` in docs is not rewritten.
 */
export function normalizeLatexDelimiters(src: string): string {
  if (!src.includes("\\(") && !src.includes("\\[") && !src.includes("\\begin")) {
    // Still may have $ math — return as-is for remark-math.
    return src;
  }

  const protectedChunks: string[] = [];
  const stash = (block: string) => {
    const i = protectedChunks.length;
    protectedChunks.push(block);
    return `\u0000PROT${i}\u0000`;
  };

  // Fenced code: ``` or ~~~ or 4+ backticks, optional language tag.
  // Unclosed fences are protected through end-of-string.
  let out = src.replace(
    /(?:^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*(?=\n|$)|$)/g,
    (block) => stash(block),
  );

  // Inline code spans: one or more backticks (GFM-style).
  out = out.replace(/(`+)((?:(?!\1).|\n)*?)\1/g, (block) => stash(block));

  // Block math: \[ ... \] (possibly multiline)
  out = out.replace(/\\\[((?:\\.|[\s\S])*?)\\\]/g, (_m, inner: string) => {
    const body = inner.trim();
    return `\n$$\n${body}\n$$\n`;
  });

  // Inline math: \( ... \)
  out = out.replace(/\\\(((?:\\.|[\s\S])*?)\\\)/g, (_m, inner: string) => {
    return `$${inner.trim()}$`;
  });

  // Common display environments without $$ wrappers
  out = out.replace(
    /(?:^|\n)(\\begin\{(?:equation|align|aligned|gather|multline)\*?\}[\s\S]*?\\end\{(?:equation|align|aligned|gather|multline)\*?\})(?=\n|$)/g,
    (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`,
  );

  out = out.replace(
    /\u0000PROT(\d+)\u0000/g,
    (_m, i: string) => protectedChunks[Number(i)] ?? "",
  );
  return out;
}

type Props = {
  children: string;
  className?: string;
};

/**
 * Shared markdown renderer for assistant / subagent output.
 * GFM + KaTeX math ($...$, $$...$$, and normalized \( \)/\[ \]).
 */
export function Markdown({ children, className }: Props) {
  const text = useMemo(() => normalizeLatexDelimiters(children), [children]);
  if (!text) return null;
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
