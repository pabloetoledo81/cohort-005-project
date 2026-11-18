// PROTOTYPE — throwaway. Floating bar to flip between UI prototype variants
// (?variant=) and feed states (?state=). Dev builds only.
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "~/lib/utils";

type Props = {
  variants: readonly { key: string; name: string }[];
  states?: readonly string[];
};

export function PrototypeSwitcher({ variants, states = [] }: Props) {
  const [params, setParams] = useSearchParams();
  const current = params.get("variant") ?? variants[0].key;
  const idx = Math.max(0, variants.findIndex((v) => v.key === current));
  const state = params.get("state") ?? states[0];

  const set = (key: string, value: string) =>
    setParams(
      (p) => {
        p.set(key, value);
        if (key === "variant") p.delete("feed");
        return p;
      },
      { replace: true }
    );
  const step = (d: number) =>
    set("variant", variants[(idx + d + variants.length) % variants.length].key);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true']")) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900 px-2 py-1.5 text-sm text-white shadow-2xl ring-2 ring-amber-400">
      <span className="pl-2 text-[10px] font-bold uppercase tracking-wider text-amber-400">
        Prototype
      </span>
      <button onClick={() => step(-1)} className="rounded-full p-1 hover:bg-white/15">
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-44 text-center font-medium">
        {variants[idx].key} ({variants[idx].name})
      </span>
      <button onClick={() => step(1)} className="rounded-full p-1 hover:bg-white/15">
        <ChevronRight className="size-4" />
      </button>
      {states.length > 0 && (
        <span className="ml-1 flex gap-0.5 rounded-full bg-white/10 p-0.5">
          {states.map((s) => (
            <button
              key={s}
              onClick={() => set("state", s)}
              className={cn(
                "rounded-full px-2 py-0.5 text-xs",
                s === state ? "bg-amber-400 text-zinc-900" : "hover:bg-white/15"
              )}
            >
              {s}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
