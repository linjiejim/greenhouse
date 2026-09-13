import './app.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SproutyLabPage } from './pages/sprouty-lab';
import { ToastContainer } from './components/ui';
import { initTheme } from './lib/theme';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SproutyLabPage />
    <ToastContainer />
  </React.StrictMode>,
);
