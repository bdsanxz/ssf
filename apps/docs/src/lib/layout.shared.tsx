import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { KeyRound } from 'lucide-react';
import { appName } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-6 items-center justify-center rounded-md bg-fd-primary text-fd-primary-foreground">
            <KeyRound className="size-3.5" />
          </span>
          {appName}
        </span>
      ),
    },
  };
}
