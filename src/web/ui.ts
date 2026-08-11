import { DASHBOARD_CSS } from './ui/styles.js';
import { renderShell } from './ui/template.js';
import { DASHBOARD_CLIENT } from './ui/client.js';

export function renderPage(): string {
  return renderShell({ css: DASHBOARD_CSS, client: DASHBOARD_CLIENT });
}
