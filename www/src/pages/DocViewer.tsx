import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { codeToHtml } from 'shiki';
import { useParams, Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Mermaid } from '../components/Mermaid';

// Import all markdown files as raw strings
const markdownModules = import.meta.glob('../../../docs/**/*.md', { query: '?raw', import: 'default' });

export function DocViewer() {
  const { t, i18n } = useTranslation();
  const { '*': docPath } = useParams(); // Catch-all route for docs/*
  
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    async function loadDoc() {
      setLoading(true);
      const lang = i18n.language;
      const targetDoc = docPath ? `${docPath}.md` : 'guide.md'; // default doc
      
      // We map i18n languages to doc folder languages. 
      // en -> en, zh-CN -> zh-CN, ja -> ja, fr -> fr
      let modulePath = `../../../docs/${lang}/${targetDoc}`;
      
      let loadFn = markdownModules[modulePath];
      
      if (!loadFn) {
        // Fallback to english if not found
        modulePath = `../../../docs/en/${targetDoc}`;
        loadFn = markdownModules[modulePath];
      }

      if (loadFn) {
        try {
          const rawMd = (await loadFn()) as string;
          setContent(rawMd);
        } catch (e) {
          setContent('# Error loading document\n\nDocument could not be loaded.');
        }
      } else {
        setContent(`# 404\n\nDocument not found at path: \`${modulePath}\`\n\nAvailable keys:\n${Object.keys(markdownModules).map(k => '- `' + k + '`').join('\n')}`);
      }
      setLoading(false);
    }
    loadDoc();
  }, [i18n.language, docPath]);

  return (
    <div className="container mx-auto px-4 py-12 flex max-w-6xl">
      <Helmet>
        <title>{`${docPath ? docPath.charAt(0).toUpperCase() + docPath.slice(1) : 'Guide'} Documentation - Open Agent Team`}</title>
      </Helmet>
      <aside className="w-64 flex-shrink-0 hidden md:block border-r border-border pr-6 mr-6">
        <nav className="sticky top-24 flex flex-col gap-3">
          <div className="font-semibold mb-2">{t('nav.docs', 'Documentation')}</div>
          <Link to="/docs/guide" className={`text-sm ${docPath === 'guide' || !docPath ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'}`}>{t('docs.guide', 'Guide')}</Link>
          <Link to="/docs/architecture" className={`text-sm ${docPath === 'architecture' ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'}`}>{t('docs.architecture', 'Architecture')}</Link>
          <Link to="/docs/config" className={`text-sm ${docPath === 'config' ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'}`}>{t('docs.config', 'Configuration')}</Link>
          <Link to="/docs/cli" className={`text-sm ${docPath === 'cli' ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'}`}>{t('docs.cli', 'CLI Reference')}</Link>
        </nav>
      </aside>
      <main className="flex-1 min-w-0 prose prose-neutral dark:prose-invert max-w-none">
        {loading ? (
          <div className="animate-pulse flex flex-col gap-4">
            <div className="h-8 bg-muted rounded w-1/3"></div>
            <div className="h-4 bg-muted rounded w-full"></div>
            <div className="h-4 bg-muted rounded w-5/6"></div>
          </div>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              pre({ children }) {
                return <>{children}</>;
              },
              code({ node, inline, className, children, ...props }: any) {
                const match = /language-(\w+)/.exec(className || '');
                const [html, setHtml] = useState<string>('');
                const [isDark, setIsDark] = useState(() => {
                  const attr = document.documentElement.getAttribute('data-theme');
                  if (attr === 'dark') return true;
                  if (attr === 'white' || attr === 'light') return false;
                  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
                });

                useEffect(() => {
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

                useEffect(() => {
                  if (!inline && match && match[1] !== 'mermaid') {
                    codeToHtml(String(children).replace(/\n$/, ''), {
                      lang: match[1],
                      theme: isDark ? 'vitesse-dark' : 'vitesse-light'
                    }).then(setHtml);
                  }
                }, [children, inline, match, isDark]);

                if (!inline && match) {
                  if (match[1] === 'mermaid') {
                    return <Mermaid chart={String(children).replace(/\n$/, '')} isDark={isDark} />;
                  }
                  
                  return html ? (
                    <div dangerouslySetInnerHTML={{ __html: html }} />
                  ) : (
                    <pre 
                      className={className} 
                      style={{ 
                        backgroundColor: isDark ? '#121212' : '#ffffff', 
                        color: isDark ? '#dbd7ca' : '#393a34',
                        padding: '1em',
                        borderRadius: '0.25rem',
                        overflowX: 'auto'
                      }}
                    >
                      <code {...props}>{children}</code>
                    </pre>
                  );
                }
                return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>{children}</code>;
              }
            }}
          >
            {content}
          </ReactMarkdown>
        )}
      </main>
    </div>
  );
}
