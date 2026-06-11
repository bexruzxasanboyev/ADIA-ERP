import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// React Flow ships its own stylesheet that sets `.react-flow` to
// `position: relative; width: 100%; height: 100%`. Import it BEFORE
// `index.css` so our Tailwind utility layer can still override
// individual properties (background dots, edge stroke) without
// fighting the base flow layout rules.
import 'reactflow/dist/style.css';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root topilmadi.');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
