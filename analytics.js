/* Anonymous page loads only: no cookies, visitor IDs, referrers or arbitrary query strings. */
(() => {
  'use strict';
  if (!['thechroniclesofafilm.com', 'www.thechroniclesofafilm.com'].includes(location.hostname)) return;
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true || navigator.webdriver) return;
  const pages = ['/', '/index.html', '/archive.html', '/chapters.html', '/chronicles.html', '/series.html'];
  if (!pages.includes(location.pathname)) return;
  let path = location.pathname === '/index.html' ? '/' : location.pathname;
  if (path === '/series.html') {
    const slug = new URLSearchParams(location.search).get('s');
    if (!slug || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) return;
    path += `?s=${slug}`;
  }
  const send = () => fetch('https://lxbiilrtzjgueekavglm.supabase.co/functions/v1/tcof-publisher/pageview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    keepalive: true,
  }).catch(() => {});
  if (document.visibilityState === 'visible') send();
  else document.addEventListener('visibilitychange', function visible() {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', visible);
    send();
  });
})();
