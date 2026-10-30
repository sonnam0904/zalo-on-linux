// Load the supplied viewer extension only when Zalo opens an image viewer.
(() => {
  if (window.__zaloLinuxViewerLoader) return;
  window.__zaloLinuxViewerLoader = true;
  const base = new URL('.', document.currentScript.src);
  const version = '20260913-1';
  const resource = name => {
    const url = new URL(name, base);
    url.searchParams.set('v', version);
    return url.href;
  };
  let loading = false;
  function script(name) {
    return new Promise((resolve, reject) => {
      const element = document.createElement('script');
      element.src = resource(name);
      element.onload = resolve;
      element.onerror = () => {element.remove(); reject(new Error('Viewer resource unavailable'));};
      document.head.appendChild(element);
    });
  }
  async function check() {
    if (loading || !document.querySelector('.media-viewer__footer__child.image-action, .media-viewer .image-action, .media-viewer__footer action-group')) return;
    loading = true;
    observer.disconnect();
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = resource('viewer.css');
    document.head.appendChild(css);
    try {
      // Keep Zalo's own globals intact if another Fabric version is present.
      if (window.fabric && window.fabric.version !== '5.3.0') throw new Error('Conflicting image editor dependency');
      if (!window.fabric) await script('fabric-5.3.0.js');
      await script('viewer.js');
    } catch (error) {
      console.error('Zalo Linux viewer extras could not load:', error.message);
    }
  }
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, {subtree: true, childList: true});
  check();
})();
