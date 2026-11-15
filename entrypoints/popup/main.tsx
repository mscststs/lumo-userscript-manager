import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/globals.css';
import '@/i18n';
import { bootstrapPage } from '@/lib/page-bootstrap';
import { AppDirection } from '@/components/direction-provider';

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Lumo Us] Unhandled promise rejection:', event.reason);
});

bootstrapPage().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppDirection>
        <App />
      </AppDirection>
    </React.StrictMode>,
  );
});
