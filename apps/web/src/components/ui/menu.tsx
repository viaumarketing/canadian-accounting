'use client';
import * as M from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuContent = ({ className, ...p }: ComponentProps<typeof M.Content>) => (
  <M.Portal>
    <M.Content
      align="start"
      sideOffset={6}
      className={cn('z-50 min-w-56 rounded-md border bg-card p-1 text-card-foreground shadow-lg', className)}
      {...p}
    />
  </M.Portal>
);
export const MenuItem = ({ className, ...p }: ComponentProps<typeof M.Item>) => (
  <M.Item
    className={cn('flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground', className)}
    {...p}
  />
);
export const MenuLabel = ({ className, ...p }: ComponentProps<typeof M.Label>) => (
  <M.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...p} />
);
export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-border" />;
