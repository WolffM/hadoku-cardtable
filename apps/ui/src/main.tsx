import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// `styles.css` first, and deliberately: it defines the palette on `:root`, and
// the shell's own stylesheet (imported by `App.tsx`) consumes those tokens
// without redefining any of them. ESM evaluates imports in source order, so
// listing `App` first would put the shell's rules ahead of the table's in the
// cascade for no reason.
import './styles.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
