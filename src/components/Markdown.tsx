import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/cn";

interface Props {
  content: string;
  className?: string;
}

export const Markdown = memo(function Markdown({ content, className }: Props) {
  return (
    <div
      className={cn(
        "markdown-body text-sm leading-snug break-words",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...p }) => (
            <h1 className="text-base font-semibold text-base-100 mt-3 mb-1" {...p} />
          ),
          h2: ({ node, ...p }) => (
            <h2 className="text-sm font-semibold text-base-100 mt-3 mb-1" {...p} />
          ),
          h3: ({ node, ...p }) => (
            <h3 className="text-sm font-semibold text-base-200 mt-2 mb-1" {...p} />
          ),
          h4: ({ node, ...p }) => (
            <h4 className="text-xs font-semibold uppercase tracking-wide text-base-300 mt-2 mb-1" {...p} />
          ),
          h5: ({ node, ...p }) => (
            <h5 className="text-xs font-semibold text-base-300 mt-2 mb-1" {...p} />
          ),
          h6: ({ node, ...p }) => (
            <h6 className="text-xs font-semibold text-base-400 mt-2 mb-1" {...p} />
          ),
          p: ({ node, ...p }) => <p className="my-1.5 whitespace-pre-wrap" {...p} />,
          strong: ({ node, ...p }) => (
            <strong className="font-semibold text-base-100" {...p} />
          ),
          em: ({ node, ...p }) => <em className="italic" {...p} />,
          ul: ({ node, ...p }) => (
            <ul className="list-disc pl-5 my-1.5 space-y-0.5 marker:text-base-500" {...p} />
          ),
          ol: ({ node, ...p }) => (
            <ol className="list-decimal pl-5 my-1.5 space-y-0.5 marker:text-base-500" {...p} />
          ),
          li: ({ node, ...p }) => <li className="leading-snug" {...p} />,
          a: ({ node, ...p }) => (
            <a
              className="text-(--color-accent-cyan) underline underline-offset-2 hover:text-(--color-accent-cyan)/80"
              target="_blank"
              rel="noreferrer noopener"
              {...p}
            />
          ),
          blockquote: ({ node, ...p }) => (
            <blockquote
              className="border-l-2 border-base-700 pl-3 my-1.5 text-base-400 italic"
              {...p}
            />
          ),
          hr: () => <hr className="my-2 border-base-800" />,
          code: ({ node, className: cls, children, ...rest }) => {
            const inline = !/language-/.test(cls ?? "");
            if (inline) {
              return (
                <code
                  className="px-1 py-0.5 rounded bg-base-950 border border-base-800 text-[0.85em] font-mono text-(--color-accent-cyan)"
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={cn("font-mono text-xs", cls)} {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ node, ...p }) => (
            <pre
              className="my-1.5 rounded-md bg-base-950 border border-base-800 p-2 overflow-x-auto text-xs font-mono"
              {...p}
            />
          ),
          table: ({ node, ...p }) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="text-xs border-collapse" {...p} />
            </div>
          ),
          th: ({ node, ...p }) => (
            <th
              className="border border-base-700 px-2 py-1 bg-base-900 text-left font-semibold"
              {...p}
            />
          ),
          td: ({ node, ...p }) => (
            <td className="border border-base-800 px-2 py-1" {...p} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
