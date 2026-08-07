import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn";

// Simplified cousin of t3's packages/ui/src/badge.tsx (outline variant only
// — the job board just needs a quiet kind tag, e.g. "mesh"/"solve").
const badgeVariants = cva(
  "inline-flex h-[18px] shrink-0 items-center justify-center whitespace-nowrap rounded-sm border " +
    "border-border bg-transparent px-1.5 text-[11px] font-medium text-muted-foreground",
);

export function Badge({ className, ...props }) {
  return <span className={cn(badgeVariants(), className)} {...props} />;
}
