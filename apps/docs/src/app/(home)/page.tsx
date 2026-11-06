import Link from 'next/link';
import {
  ArrowRight,
  BookOpen,
  Fingerprint,
  KeyRound,
  Map,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const pillars = [
  {
    icon: Fingerprint,
    title: 'Secure distribution',
    body: 'Skills ship as packages with a protected artifact. Without a valid license, protected content is ciphertext.',
  },
  {
    icon: KeyRound,
    title: 'Authenticated runtime',
    body: 'Protected resources open only through the skill runtime with a valid license. No database required.',
  },
  {
    icon: ShieldCheck,
    title: 'Context-aware access',
    body: 'Companion files read progressively; scripts run without exposing source — an output contract built for agents.',
  },
];

const entries = [
  {
    icon: BookOpen,
    title: 'Start with the guides',
    body: 'Protection tiers, workspace, builds, and licensing.',
    href: '/docs/getting-started',
  },
  {
    icon: Map,
    title: "What's coming",
    body: 'Release scope and what lands later.',
    href: '/docs/roadmap',
  },
];

export default function HomePage() {
  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Backdrop */}
      <div aria-hidden className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-grid mask-fade-y text-fd-foreground" />
        <div className="absolute inset-0 glow-beam text-fd-foreground" />
      </div>

      <div className="mx-auto max-w-5xl px-6 pt-20 pb-16 text-center sm:pt-28">
        <Badge variant="neutral" className="mb-6">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          Open-source framework · Agent Skills compatible
        </Badge>

        <h1 className="text-5xl font-semibold leading-[1.05] tracking-[-0.04em] text-balance sm:text-7xl">
          Ship skills
          <br />
          <span className="text-gradient">without shipping source.</span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-base text-pretty text-fd-muted-foreground sm:text-lg">
          The Secure Skill Framework protects, distributes, and runs AI
          agent skills with license-key authentication. License enforcement
          plus deterrent — never absolute secrecy.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/docs">
            <Button variant="primary">
              Read the documentation
              <ArrowRight />
            </Button>
          </Link>
          <Link href="/docs/roadmap">
            <Button variant="secondary">What&apos;s coming</Button>
          </Link>
        </div>

        <div className="mx-auto mt-16 grid max-w-4xl gap-3 text-left sm:grid-cols-3">
          {pillars.map((pillar) => (
            <div
              key={pillar.title}
              className="card-hairline rounded-2xl bg-fd-card/50 p-5 backdrop-blur"
            >
              <pillar.icon className="size-5 text-fd-foreground" />
              <h2 className="mt-3 text-sm font-semibold">{pillar.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">
                {pillar.body}
              </p>
            </div>
          ))}
        </div>

        <div className="mx-auto mt-3 grid max-w-4xl gap-3 text-left sm:grid-cols-2">
          {entries.map((entry) => (
            <Link
              key={entry.title}
              href={entry.href}
              className="card-hairline group flex items-center gap-4 rounded-2xl bg-fd-card/50 p-5 backdrop-blur"
            >
              <entry.icon className="size-5 shrink-0 text-fd-muted-foreground transition-colors group-hover:text-fd-foreground" />
              <span>
                <span className="block text-sm font-semibold">
                  {entry.title}
                </span>
                <span className="mt-0.5 block text-sm text-fd-muted-foreground">
                  {entry.body}
                </span>
              </span>
              <ArrowRight className="ms-auto size-4 shrink-0 text-fd-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-fd-foreground" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
