import { COMPILED_WEB_EXTENSIONS } from './extensions/index';
import { registerWebExtensions } from './extensions/registry';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import '@greenhouse/ui/styles/fonts.css';
import '@greenhouse/ui/tokens/haven.css';
import '@greenhouse/ui/kit/kit.css';
import '@greenhouse/ui/styles/brand.css';
import './styles/app.css';
import { queryClient } from './data/query';
import { SessionProvider } from './app/session';
import { App } from './app/App';
import { initDesktop } from './lib/desktop';

registerWebExtensions(COMPILED_WEB_EXTENSIONS);

if (initDesktop())
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
