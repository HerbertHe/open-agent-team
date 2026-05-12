import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Header } from './components/Header';
import './App.less';

const Home = lazy(() => import('./pages/Home').then(module => ({ default: module.Home })));
const DocViewer = lazy(() => import('./pages/DocViewer').then(module => ({ default: module.DocViewer })));

function App() {
  return (
    <div className="app-container bg-background text-foreground font-sans selection:bg-primary/10">
      <Header />
      <div className="main-content">
        <Suspense fallback={<div className="flex justify-center p-12"><div className="animate-pulse text-muted-foreground">Loading...</div></div>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/docs/*" element={<DocViewer />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

export default App;
