import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const params = new URLSearchParams(window.location.search);
const lab = params.get('lab');

const App = lazy(() => import('./App'));
const AvatarLab = lazy(() => import('./dev/AvatarLab'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>{lab === 'avatar' ? <AvatarLab /> : <App />}</Suspense>
  </StrictMode>,
);
