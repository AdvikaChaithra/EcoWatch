"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Renders the active tab and keeps tabs you already visited mounted (hidden), so switching back is
 * instant instead of re-fetching everything from the database. A tab hidden for longer than
 * `staleMs` is re-mounted (fresh data) when shown again. Tabs in `noKeep` (maps, which mis-size
 * while hidden, and the camera, which must be released) are unmounted when you leave them.
 */
export function KeepAliveTabs<T extends string>({ active, panels, noKeep = [], staleMs = 30_000 }: {
  active: T;
  panels: Record<T, () => React.ReactNode>;
  noKeep?: T[];
  staleMs?: number;
}) {
  const [state, setState] = useState<Record<string, { key: number; hiddenAt: number | null }>>({ [active]: { key: 0, hiddenAt: null } });
  const prev = useRef<T>(active);

  useEffect(() => {
    const from = prev.current;
    if (from === active) return;
    prev.current = active;
    setState((s) => {
      const next = { ...s };
      if (noKeep.includes(from)) delete next[from];
      else if (next[from]) next[from] = { ...next[from], hiddenAt: Date.now() };
      const cur = next[active];
      if (!cur) next[active] = { key: 0, hiddenAt: null };
      else next[active] = { key: cur.hiddenAt && Date.now() - cur.hiddenAt > staleMs ? cur.key + 1 : cur.key, hiddenAt: null };
      return next;
    });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // the active tab always renders, even in the frame before the effect above records it
  const ids = Array.from(new Set([...Object.keys(state), active])) as T[];
  return (
    <>
      {ids.map((id) => (
        <div key={`${id}:${state[id]?.key ?? 0}`} hidden={id !== active}>
          {panels[id]()}
        </div>
      ))}
    </>
  );
}
