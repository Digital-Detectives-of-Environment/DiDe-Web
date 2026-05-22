// DiDe — i18n Core Manager
// Dil dosyalarını dinamik olarak yükler.
// Kullanım: main.js her zaman yüklenir, dil dosyaları (TR.js, EN.js, IT.js vb.) ihtiyaç halinde yüklenir.

(function () {
  'use strict';

  // Loaded language data lives here
  window.i18nLangs = window.i18nLangs || {};

  var currentLanguage = 'en';
  var defaultLang = 'en';        // will be overridden by config (DEFAULT_LANG from .env)
  var loadedScripts = {};        // track which scripts have been loaded
  var _configFetched = false;

  // ── helpers ──

  function replacePlaceholders(str, params) {
    if (!params) return str;
    return str.replace(/\{\{(\w+)\}\}/g, function (match, key) {
      return params[key] !== undefined ? params[key] : match;
    });
  }

  function _loadScript(url) {
    return new Promise(function (resolve, reject) {
      if (loadedScripts[url]) { resolve(); return; }
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { loadedScripts[url] = true; resolve(); };
      s.onerror = function () { reject(new Error('Failed to load: ' + url)); };
      document.head.appendChild(s);
    });
  }

  // ── public API ──

  /**
   * Load translations for a given language code.
   * Dynamically loads /i18n/XX.js if not already loaded.
   * @param {string} lang - language code in lowercase (e.g. 'tr', 'en', 'it')
   */
  async function loadTranslations(lang) {
    var code = (lang || 'en').toLowerCase();
    var fileCode = code.toUpperCase(); // file names are uppercase: TR.js, EN.js, IT.js
    if (!window.i18nLangs[code]) {
      try {
        await _loadScript('/i18n/' + fileCode + '.js');
      } catch (e) {
        console.warn('[i18n] Could not load language file:', fileCode + '.js', e);
      }
    }
  }

  /**
   * Translate a key with optional parameters.
   * Falls back: currentLanguage → 'en' → key itself.
   */
  function t(key, params) {
    var keys = key.split('.');
    var value;

    // Try current language
    value = _resolve(currentLanguage, keys);
    if (typeof value === 'string') return replacePlaceholders(value, params);
    if (Array.isArray(value)) return value;

    // Fallback to EN
    if (currentLanguage !== 'en') {
      value = _resolve('en', keys);
      if (typeof value === 'string') return replacePlaceholders(value, params);
      if (Array.isArray(value)) return value;
    }

    // Fallback to default lang (from .env)
    if (currentLanguage !== defaultLang && defaultLang !== 'en') {
      value = _resolve(defaultLang, keys);
      if (typeof value === 'string') return replacePlaceholders(value, params);
      if (Array.isArray(value)) return value;
    }

    return key;
  }

  function _resolve(lang, keys) {
    var obj = window.i18nLangs[lang];
    if (!obj) return undefined;
    for (var i = 0; i < keys.length; i++) {
      if (obj && typeof obj === 'object') {
        obj = obj[keys[i]];
      } else {
        return undefined;
      }
    }
    return obj;
  }

  function setLanguage(lang) {
    var code = (lang || 'en').toLowerCase();
    currentLanguage = code;
    try {
      localStorage.setItem('app_language', code);
    } catch (e) { /* ignore */ }
    document.documentElement.lang = code;
    window.dispatchEvent(new CustomEvent('languagechange', { detail: { language: code } }));
  }

  function getLanguage() {
    return currentLanguage;
  }

  /**
   * Get the configured default language (from .env DEFAULT_LANG).
   * Available after initLanguage() resolves.
   */
  function getDefaultLang() {
    return defaultLang;
  }

  /**
   * Initialize i18n: fetch config, load required language files, restore saved preference.
   * Called once at page load (before app.js init).
   */
  async function initLanguage() {
    // 1) Fetch server config to get DEFAULT_LANG
    if (!_configFetched) {
      try {
        var resp = await fetch('/api/config');
        if (resp.ok) {
          var cfg = await resp.json();
          if (cfg.defaultLang) {
            defaultLang = cfg.defaultLang.toLowerCase();
          }
        }
      } catch (e) {
        console.warn('[i18n] Could not fetch config for defaultLang');
      }
      _configFetched = true;
    }

    // 2) Always load EN
    await loadTranslations('en');

    // 3) Load the default language (from .env)
    if (defaultLang !== 'en') {
      await loadTranslations(defaultLang);
    }

    // 4) Restore saved language preference
    var saved = null;
    try { saved = localStorage.getItem('app_language'); } catch (e) { /* ignore */ }

    if (saved && (saved === 'en' || saved === defaultLang)) {
      currentLanguage = saved;
    } else {
      // Default: start with EN
      currentLanguage = 'en';
    }

    document.documentElement.lang = currentLanguage;
  }

  // Compatibility: expose a translations-like object for code that reads window.i18n.translations
  var translationsProxy = new Proxy({}, {
    get: function (target, prop) {
      return window.i18nLangs[prop];
    },
    ownKeys: function () {
      return Object.keys(window.i18nLangs);
    },
    getOwnPropertyDescriptor: function (target, prop) {
      if (window.i18nLangs[prop]) {
        return { configurable: true, enumerable: true, value: window.i18nLangs[prop] };
      }
      return undefined;
    }
  });

  // ── expose globally ──
  window.t = t;
  window.setLanguage = setLanguage;
  window.getLanguage = getLanguage;
  window.getDefaultLang = getDefaultLang;
  window.loadTranslations = loadTranslations;
  window.i18n = {
    t: t,
    setLanguage: setLanguage,
    getLanguage: getLanguage,
    getDefaultLang: getDefaultLang,
    loadTranslations: loadTranslations,
    translations: translationsProxy
  };

  // Auto-init: start loading immediately (non-blocking for script parsing)
  var _initPromise = initLanguage();
  window._i18nReady = _initPromise;

  // Also fire a ready log when done
  _initPromise.then(function () {
    console.log('[i18n] loaded and ready — default:', defaultLang, '| current:', currentLanguage);
  });

})();
