/**
 * Injected into MAIN world at document_start for blacklisted domains.
 * Blocks Service Worker registration and Cache Storage access.
 */
(function () {
  'use strict';

  if (window.__swcb_active__) return;

  const TAG = '[SW & Cache Blocker]';

  Object.defineProperty(window, '__swcb_active__', {
    value: true,
    enumerable: false,
    configurable: false,
  });

  // --- Block Service Worker registration ---
  if (navigator.serviceWorker) {
    const origToString = navigator.serviceWorker.register.toString();
    navigator.serviceWorker.register = function (scriptURL) {
      console.warn(TAG, 'Blocked SW registration:', scriptURL);
      return Promise.reject(
        new DOMException(
          'Service Worker registration blocked by SW & Cache Blocker extension',
          'SecurityError'
        )
      );
    };
    navigator.serviceWorker.register.toString = () => origToString;
  }

  // --- Block Cache Storage ---
  if (window.caches) {
    const blocked = (method) =>
      function (...args) {
        console.warn(TAG, `Blocked caches.${method}():`, ...args);
        switch (method) {
          case 'has':
          case 'delete':
            return Promise.resolve(false);
          case 'keys':
            return Promise.resolve([]);
          case 'match':
            return Promise.resolve(undefined);
          default:
            return Promise.reject(
              new DOMException(
                'Cache Storage blocked by SW & Cache Blocker extension',
                'SecurityError'
              )
            );
        }
      };

    for (const m of ['open', 'has', 'delete', 'keys', 'match']) {
      Object.defineProperty(caches, m, {
        value: blocked(m),
        writable: false,
        configurable: false,
      });
    }
  }

  console.info(TAG, 'Active on', location.hostname);
})();
