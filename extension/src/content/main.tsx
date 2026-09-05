/**
 * Einstiegspunkt des Content-Scripts.
 *
 * Das bestehende Panel läuft unverändert weiter und bleibt der Besitzer des
 * Shadow-Roots; React hängt sich als eigene Insel darunter. So bleibt die
 * Extension bei jedem Schritt der Umstellung lauffähig, statt in einem
 * halbfertigen Zustand zu stehen.
 */
import { createRoot, type Root } from 'react-dom/client';

import tailwind from '@/styles/tailwind.css?inline';
import { ChatDock } from '@/content/chat-dock';
import { PanelBody } from '@/content/panel-body';
import { READY_EVENT, panelBody, panelSlot, panelShadow } from '@/content/bridge';

import '@/content/panel.js';

let chatRoot: Root | null = null;
let bodyRoot: Root | null = null;

function mount() {
  const shadow = panelShadow();
  const slot = panelSlot();
  const body = panelBody();
  if (!shadow || !slot || !body || chatRoot) return;

  // Tailwind wird als Text eingebettet: im Shadow-DOM greift kein Stylesheet
  // von außen, und ein zweiter Netzwerkabruf wäre unnötig.
  if (!shadow.querySelector('#vms-tailwind')) {
    const style = document.createElement('style');
    style.id = 'vms-tailwind';
    style.textContent = tailwind;
    shadow.appendChild(style);
  }

  bodyRoot = createRoot(body);
  bodyRoot.render(<PanelBody bodyEl={body} />);

  chatRoot = createRoot(slot);
  chatRoot.render(<ChatDock />);
}

document.addEventListener(READY_EVENT, mount);
mount();
