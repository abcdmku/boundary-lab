import { cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

// Same helper as t3's packages/ui/src/cn.ts.
export function cn(...inputs) {
  return twMerge(cx(inputs));
}
