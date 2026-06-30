import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-sm px-2 py-0.5 text-[11px] font-semibold leading-tight tracking-wide whitespace-nowrap", {
  variants: {
    variant: {
      default: "bg-primary/15 text-[hsl(var(--primary-strong))] ring-1 ring-inset ring-primary/30",
      secondary: "bg-secondary text-secondary-foreground ring-1 ring-inset ring-border",
      outline: "border border-border text-muted-foreground",
      warning: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30"
    }
  },
  defaultVariants: {
    variant: "default"
  }
});

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
