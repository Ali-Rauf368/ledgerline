import { Fragment } from "react";
import type { ReactNode } from "react";
import Link from "next/link";

/** Server-safe mini renderer: paragraphs, bullets, **bold**, *italic*, `code`, #123 journal links. */
export function RichTextStatic({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      {text.split(/\n{2,}/).map((b, i) => {
        const lines = b.split("\n").filter((l) => l.trim());
        const bullets = lines.filter((l) => /^\s*([-*•]|\d+\.)\s+/.test(l));
        const head = lines.filter((l) => !/^\s*([-*•]|\d+\.)\s+/.test(l));
        return (
          <Fragment key={i}>
            {head.length > 0 && <p>{head.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l.replace(/^#{1,4}\s+/, ""))}</Fragment>)}</p>}
            {bullets.length > 0 && <ul className="list-disc space-y-1 pl-5 marker:text-muted">{bullets.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>)}</ul>}
          </Fragment>
        );
      })}
    </div>
  );
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|#\d+\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={m.index} className="font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("*")) out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    else if (t.startsWith("`")) out.push(<code key={m.index} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px]">{t.slice(1, -1)}</code>);
    else out.push(<Link key={m.index} href={`/transactions/${t.slice(1)}`} className="font-medium text-accent hover:underline">{t}</Link>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
