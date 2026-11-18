import { renderAdaptiveView } from './adaptive-view.js';
import { activateAdaptiveMapView } from './adaptive-controller.js';

const root = document.getElementById('app');
if (root) {
  root.innerHTML = renderAdaptiveView();
  requestAnimationFrame(() => activateAdaptiveMapView());
}
