import React from 'react';
import { createRoot } from 'react-dom/client';
import '@greenhouse/ui/styles/fonts.css';
import '@greenhouse/ui/tokens/haven.css';
import '@greenhouse/ui/styles/brand.css';
import '@greenhouse/ui/kit/kit.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
