import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

interface MermaidProps {
  chart: string;
  isDark: boolean;
}

export function Mermaid({ chart, isDark }: MermaidProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');

  useEffect(() => {
    let isMounted = true;
    
    const renderChart = async () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });
        
        // Use a unique ID for each render
        const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;
        const { svg: svgCode } = await mermaid.render(id, chart);
        
        if (isMounted) {
          setSvg(svgCode);
        }
      } catch (error) {
        console.error('Mermaid rendering error:', error);
        if (isMounted) {
          setSvg(`<div class="text-destructive border border-destructive p-4 rounded bg-destructive/10 text-sm overflow-auto"><pre>${String(error)}</pre></div>`);
        }
      }
    };
    
    renderChart();
    
    return () => {
      isMounted = false;
    };
  }, [chart, isDark]);

  return (
    <div 
      ref={ref} 
      className="mermaid-wrapper my-8 flex justify-center w-full overflow-x-auto bg-card rounded-xl p-4 border border-border" 
      dangerouslySetInnerHTML={{ __html: svg || '<div class="animate-pulse h-32 w-full bg-muted rounded"></div>' }} 
    />
  );
}
