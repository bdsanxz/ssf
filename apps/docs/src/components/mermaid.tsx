'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/cn';

/**
 * Client-rendered Mermaid diagram. The `mermaid` library is loaded
 * dynamically on mount so pages without diagrams pay no bundle cost.
 * Follows the site light/dark theme.
 */
export function Mermaid({
  chart,
  className,
}: {
  chart: string;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSvg(null);
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: resolvedTheme === 'dark' ? 'dark' : 'neutral',
          themeVariables: {
            fontFamily:
              'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
          },
        });
        const { svg } = await mermaid.render(`mermaid-${id}`, chart);
        if (!cancelled) setSvg(svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (failed) {
    return (
      <pre className={cn('overflow-x-auto text-sm', className)}>
        <code>{chart}</code>
      </pre>
    );
  }

  return (
    <div
      className={cn(
        'my-6 flex justify-center overflow-x-auto rounded-2xl border border-fd-border bg-fd-card/40 p-4 sm:p-6 [&_svg]:max-w-full [&_svg]:shrink-0',
        className,
      )}
      aria-label="Architecture diagram"
      role="img"
      // mermaid output is sanitized by the library (strict security level)
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
