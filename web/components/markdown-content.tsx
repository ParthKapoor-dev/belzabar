"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

export function MarkdownContent({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-sm leading-relaxed break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return (
              <pre className="my-2 overflow-x-auto rounded bg-muted/40 p-3 text-xs leading-relaxed font-mono">
                {children}
              </pre>
            )
          },
          code({ className: cls, children }) {
            const isBlock = /language-\w+/.test(cls ?? "")
            if (isBlock) {
              return <code className={cn("font-mono text-xs", cls)}>{children}</code>
            }
            return (
              <code className="rounded bg-muted/60 px-1 py-0.5 text-xs font-mono">{children}</code>
            )
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                {children}
              </a>
            )
          },
          blockquote({ children }) {
            return (
              <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground italic">
                {children}
              </blockquote>
            )
          },
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="w-full border-collapse text-xs">{children}</table>
              </div>
            )
          },
          th({ children }) {
            return (
              <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>
            )
          },
          td({ children }) {
            return <td className="border border-border px-2 py-1">{children}</td>
          },
          h1({ children }) {
            return <h1 className="mt-4 mb-1 text-base font-semibold">{children}</h1>
          },
          h2({ children }) {
            return <h2 className="mt-3 mb-1 text-sm font-semibold">{children}</h2>
          },
          h3({ children }) {
            return <h3 className="mt-2 mb-1 text-sm font-medium">{children}</h3>
          },
          ul({ children }) {
            return <ul className="my-1 list-disc pl-5 space-y-0.5">{children}</ul>
          },
          ol({ children }) {
            return <ol className="my-1 list-decimal pl-5 space-y-0.5">{children}</ol>
          },
          li({ children }) {
            return <li className="text-sm">{children}</li>
          },
          p({ children }) {
            return <p className="my-1">{children}</p>
          },
          hr() {
            return <hr className="my-3 border-border" />
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
