/**
 * Entry point for the Caregrid workspace.
 *
 * Fastify serves this bundle from `/`, so the mount step is deliberately forgiving: an existing
 * `<caregrid-app>` element in `index.html` is adopted, otherwise the app is appended to `#app` when
 * that container exists and to `<body>` when it does not.
 */

import './styles.css';
import { CaregridApp } from './app.js';
import { defineOnce } from './lib/define.js';

defineOnce('caregrid-app', CaregridApp);

function mount(): void {
  const container = document.getElementById('app') ?? document.body;
  const existing = document.querySelector('caregrid-app');
  if (existing) {
    return;
  }
  container.append(document.createElement('caregrid-app'));
  if (document.title.trim() === '' || document.title === 'Vite App') {
    document.title = 'Caregrid · community clinic desk';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
