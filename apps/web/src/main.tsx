import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router.js';
import { I18nProvider } from './i18n/index.js';
import './index.css';

// The open-source app runs fully anonymous: share the room code and
// anyone joins. No auth wiring — room creation, messaging, and reports
// all work without a sign-in.
//
// `I18nProvider` sits above the router so the 한국어 / EN choice survives every
// route change; Korean is the default and the stored choice wins on reload.
const root = ReactDOM.createRoot(document.getElementById('root')!);

root.render(
  <React.StrictMode>
    <I18nProvider>
      <RouterProvider router={router} />
    </I18nProvider>
  </React.StrictMode>
);
