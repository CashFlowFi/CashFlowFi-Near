import Link from "next/link";
import { GUIDES } from "@/lib/guides";

/** "I am a…": one card per role, each opening that role's step-by-step guide. */
export function RoleChooser({ current }: { current?: string }) {
  return (
    <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {GUIDES.map((g) => {
        const on = g.key === current;
        return (
          <li key={g.key}>
            <Link
              href={`/start/${g.key}`}
              aria-current={on ? "page" : undefined}
              className={`group card flex h-full flex-col p-4 transition-colors hover:border-accent ${on ? "!border-accent" : ""}`}
            >
              <span aria-hidden="true" className="text-2xl">{g.emoji}</span>
              <span className="mt-2 flex items-center font-medium">
                {g.label}
                <span aria-hidden="true" className="ml-auto text-muted transition-transform group-hover:translate-x-0.5">→</span>
              </span>
              <span className="mt-1 text-sm text-muted">{g.pitch}</span>
              <span className="num mt-3 text-[11px] text-muted">{g.steps.length} steps</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
