"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Renders children into <body>. Overlays must use this: an ancestor with a transform (fade-in
 * animations) or backdrop-filter (glass cards) becomes the containing block for `position: fixed`,
 * which pushes the dialog off-screen on long pages.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted ? createPortal(children, document.body) : null;
}
