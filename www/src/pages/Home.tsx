import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowRight, FileJson, ShieldCheck, Zap, GitMerge, Puzzle, LayoutDashboard } from 'lucide-react';
import { ParticleCanvas } from '../components/ParticleCanvas';

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
  observe: <LayoutDashboard size={28} className="text-primary" />,
};

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
        <title>{`${t('hero.title', 'Open Agent Team')} - Programmable Framework`}</title>
      </Helmet>
      <main className="flex-1">
        <Hero />
        <Features />
      </main>
      <Footer />
    </div>
  );
}
