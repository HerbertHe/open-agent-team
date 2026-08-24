import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Activity, ArrowRight, FileJson, ShieldCheck, Zap, GitMerge, Puzzle, Copy, Check, ClipboardCheck, GitPullRequest, Container, BrainCircuit } from 'lucide-react';
import { ParticleCanvas } from '../components/ParticleCanvas';
import { codeToHtml } from 'shiki';
import { motion } from 'framer-motion';

function Hero() {
  const { t } = useTranslation();
  return (
    <section className="relative py-24 md:py-32 flex flex-col items-center text-center px-4 overflow-hidden">
      <ParticleCanvas />
      <div className="relative z-10 flex flex-col items-center">
        <div className="flex justify-center mb-6">
          <img src="/logo.svg" alt="OAT Logo" className="w-20 h-20 md:w-28 md:h-28" />
        </div>
        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight max-w-4xl mb-6">
          {t('hero.title')}
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mb-10 leading-relaxed">
          {t('hero.subtitle1')}<br />{t('hero.subtitle2')}
        </p>
        <div className="flex flex-wrap gap-4 justify-center">
          <Link
            to="/docs"
            className="bg-primary text-primary-foreground px-8 py-3 rounded-md font-semibold hover:bg-primary/90 transition-colors flex items-center gap-2"
          >
            {t('hero.getStarted')}
            <ArrowRight size={18} />
          </Link>
          <a
            href="https://github.com/HerbertHe/open-agent-team"
            target="_blank"
            rel="noreferrer"
            className="bg-transparent border border-border text-foreground px-8 py-3 rounded-md font-semibold hover:bg-muted transition-colors flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path><path d="M9 18c-4.51 2-5-2-7-2"></path></svg>
            {t('nav.github')}
          </a>
        </div>
      </div>
    </section>
  );
}

const FEATURE_ICONS: Record<string, React.ReactNode> = {
  role: <FileJson size={28} className="text-primary" />,
  sandbox: <ShieldCheck size={28} className="text-primary" />,
  dynamic: <Zap size={28} className="text-primary" />,
  merge: <GitMerge size={28} className="text-primary" />,
  skills: <Puzzle size={28} className="text-primary" />,
  observe: <Activity size={28} className="text-primary" />,
};

function QuickStart() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'one-liner' | 'npm'>('one-liner');
  const [os, setOs] = useState<'unix' | 'windows'>(() => {
    if (typeof window !== 'undefined' && window.navigator) {
      const userAgent = window.navigator.userAgent.toLowerCase();
      if (userAgent.includes('win')) return 'windows';
    }
    return 'unix';
  });
  const [copied, setCopied] = useState(false);

  const getCommand = () => {
    if (mode === 'npm') return 'npm i open-agent-team -g';
    if (os === 'unix') return 'curl -fsSL https://oat.ibert.me/install.sh | bash';
    return 'powershell -c "irm https://oat.ibert.me/install.ps1 | iex"';
  };

  const command = getCommand();

  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return false;
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'white' || attr === 'light') return false;
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const observer = new MutationObserver(() => {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'dark') setIsDark(true);
      else if (attr === 'white' || attr === 'light') setIsDark(false);
      else setIsDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      const attr = document.documentElement.getAttribute('data-theme');
      if (!attr || attr === 'auto') setIsDark(e.matches);
    };
    mq.addEventListener('change', handler);
    return () => { observer.disconnect(); mq.removeEventListener('change', handler); };
  }, []);

  const [html, setHtml] = useState<string>('');
  useEffect(() => {
    codeToHtml(command, {
      lang: os === 'windows' && mode !== 'npm' ? 'powershell' : 'bash',
      theme: isDark ? 'vitesse-dark' : 'vitesse-light'
    }).then(setHtml);
  }, [command, isDark, os, mode]);

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="py-24 px-4 max-w-4xl mx-auto w-full">
      <div className="text-center mb-10">
        <h2 className="text-3xl font-bold mb-4">{t('quickstart.title', 'Quick Start')}</h2>
        <p className="text-muted-foreground">{t('quickstart.subtitle', "One command, and it's yours.")}</p>
      </div>
      
      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mx-auto max-w-3xl">
        {/* Terminal Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3 bg-muted/50 border-b border-border gap-3">
          
          <div className="flex items-center gap-4">
            {/* Window Dots */}
            <div className="flex items-center gap-1.5 hidden sm:flex">
              <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
              <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
            </div>
            
            {/* Mode Tabs */}
            <div className="flex items-center p-1 rounded-lg bg-muted relative">
              {['one-liner', 'npm'].map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m as any)}
                  className={`relative z-10 px-3 py-1.5 text-xs font-semibold cursor-pointer transition-colors ${mode === m ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {m === 'one-liner' ? t('quickstart.oneliner', 'One-liner') : 'npm'}
                  {mode === m && (
                    <motion.div
                      layoutId="mode-slider"
                      className="absolute inset-0 bg-background rounded-md shadow-sm border border-border -z-10"
                      transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                    />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* OS Tabs */}
          <div className="flex items-center p-1 rounded-lg bg-muted relative">
            {['unix', 'windows'].map((o) => (
              <button
                key={o}
                onClick={() => setOs(o as any)}
                className={`relative z-10 px-3 py-1.5 text-xs font-semibold cursor-pointer transition-colors ${os === o ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {o === 'unix' ? 'macOS & Linux' : 'Windows'}
                {os === o && (
                  <motion.div
                    layoutId="os-slider"
                    className="absolute inset-0 bg-background rounded-md shadow-sm border border-border -z-10"
                    transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                  />
                )}
              </button>
            ))}
          </div>
          
        </div>
        
        {/* Terminal Body */}
        <div 
          className="py-4 px-5 relative group font-mono text-sm overflow-x-auto min-h-[80px] flex items-center"
          style={{ backgroundColor: isDark ? '#121212' : '#ffffff', color: isDark ? '#dbd7ca' : '#393a34' }}
        >
          <div className="flex items-center gap-3 pr-12">
            <span className="text-primary shrink-0 font-bold">$</span>
            {html ? (
              <div 
                dangerouslySetInnerHTML={{ __html: html }} 
                className="[&>pre]:!bg-transparent [&>pre]:!p-0 [&>pre]:!m-0" 
              />
            ) : (
              <code className="whitespace-pre">{command}</code>
            )}
          </div>
          
          <button
            onClick={handleCopy}
            className="absolute top-1/2 -translate-y-1/2 right-4 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-all cursor-pointer shadow-sm border border-border bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
            aria-label="Copy command"
          >
            {copied ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
          </button>
        </div>
      </div>
    </section>
  );
}

function Features() {
  const { t } = useTranslation();
  const features = [
    { id: 'role', title: t('feature.role.title'), desc: t('feature.role.desc') },
    { id: 'sandbox', title: t('feature.sandbox.title'), desc: t('feature.sandbox.desc') },
    { id: 'dynamic', title: t('feature.dynamic.title'), desc: t('feature.dynamic.desc') },
    { id: 'merge', title: t('feature.merge.title'), desc: t('feature.merge.desc') },
    { id: 'skills', title: t('feature.skills.title'), desc: t('feature.skills.desc') },
    { id: 'observe', title: t('feature.observe.title'), desc: t('feature.observe.desc') },
  ];

  return (
    <section className="py-24 px-4 max-w-6xl mx-auto">
      <div className="text-center mb-16">
        <h2 className="text-3xl font-bold mb-4">{t('features.title')}</h2>
        <p className="text-muted-foreground max-w-2xl mx-auto">{t('features.subtitle')}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {features.map((f) => (
          <div key={f.id} className="p-8 border border-border rounded-lg bg-card hover:border-primary/50 transition-colors">
            <div className="mb-4">{FEATURE_ICONS[f.id]}</div>
            <h3 className="text-xl font-bold mb-3">{f.title}</h3>
            <p className="text-muted-foreground leading-relaxed">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CollaborationFlow() {
  const { t } = useTranslation();
  const steps = [
    { icon: <FileJson size={22} />, title: t('flow.plan.title'), desc: t('flow.plan.desc') },
    { icon: <Zap size={22} />, title: t('flow.queue.title'), desc: t('flow.queue.desc') },
    { icon: <ClipboardCheck size={22} />, title: t('flow.verify.title'), desc: t('flow.verify.desc') },
    { icon: <GitPullRequest size={22} />, title: t('flow.review.title'), desc: t('flow.review.desc') },
    { icon: <GitMerge size={22} />, title: t('flow.release.title'), desc: t('flow.release.desc') },
  ];

  return (
    <section className="py-24 px-4 bg-muted/30 border-y border-border">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold mb-4">{t('flow.title')}</h2>
          <p className="text-muted-foreground max-w-3xl mx-auto">{t('flow.subtitle')}</p>
        </div>
        <ol className="grid grid-cols-1 md:grid-cols-5 gap-5">
          {steps.map((step, index) => (
            <li key={step.title} className="relative rounded-xl border border-border bg-card p-6">
              <span className="absolute -top-3 left-6 h-6 min-w-6 px-1 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">{index + 1}</span>
              <div className="text-primary mb-4 mt-2">{step.icon}</div>
              <h3 className="font-bold mb-2">{step.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{step.desc}</p>
            </li>
          ))}
        </ol>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-6">
          <div className="rounded-xl border border-border bg-card p-6 flex gap-4">
            <Container className="text-primary shrink-0" size={28} />
            <div><h3 className="font-bold mb-1">{t('flow.docker.title')}</h3><p className="text-sm text-muted-foreground leading-relaxed">{t('flow.docker.desc')}</p></div>
          </div>
          <div className="rounded-xl border border-border bg-card p-6 flex gap-4">
            <BrainCircuit className="text-primary shrink-0" size={28} />
            <div><h3 className="font-bold mb-1">{t('flow.memory.title')}</h3><p className="text-sm text-muted-foreground leading-relaxed">{t('flow.memory.desc')}</p></div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const { t } = useTranslation();
  const text = t('footer.copyright');
  const parts = text.split('Herbert He');

  return (
    <footer className="py-8 border-t border-border mt-12 bg-background">
      <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
        {parts[0]}
        <a
          href="https://github.com/HerbertHe"
          target="_blank"
          rel="noreferrer"
          className="text-foreground hover:text-primary transition-colors font-medium"
        >
          Herbert He
        </a>
        {parts[1]}
      </div>
    </footer>
  );
}

export function Home() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>{t('hero.title', 'Open Agent Team')}</title>
      </Helmet>
      <main className="flex-1">
        <Hero />
        <QuickStart />
        <Features />
        <CollaborationFlow />
      </main>
      <Footer />
    </div>
  );
}
