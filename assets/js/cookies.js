function getConsentKey() {
  return window.__SITE_CONFIG__?.telemetry?.consentKey || 'nexarank_cookie_consent';
}

// Detecta si localStorage está disponible. Si falla (bloqueado por el navegador,
// quota exceeded, modo privado, etc.), usaremos memoria alternativa.
function isStorageAvailable() {
  try {
    const testKey = '__storage_test__';
    localStorage.setItem(testKey, 'test');
    localStorage.removeItem(testKey);
    return true;
  } catch (e) {
    return false;
  }
}

// Memoria alternativa cuando el navegador bloquea el almacenamiento persistente.
// Se conserva durante la sesión actual (misma pestaña) y se pierde en la visita siguiente
// (nueva pestaña o cierre del navegador), cumpliendo el requisito R39.
let consentInMemory = null;

const storageAvailable = isStorageAvailable();

// Lee el estado de consentimiento de localStorage o de la memoria alternativa.
function readConsent() {
  // Intenta primero con localStorage
  if (storageAvailable) {
    try {
      const value = localStorage.getItem(getConsentKey());
      if (value !== null) {
        return value;
      }
    } catch (e) {
      // localStorage falló, continuaremos a memoria alternativa
    }
  }

  // Fellback a memoria alternativa (in-memory)
  return consentInMemory;
}

// Escribe el estado de consentimiento en localStorage o en memoria alternativa.
// Si localStorage está bloqueado, la decisión se guarda en memoria y persiste
// durante la sesión actual, pero reaparecerá el banner en la visita siguiente.
function writeConsent(value) {
  // Intenta primero con localStorage
  if (storageAvailable) {
    try {
      localStorage.setItem(getConsentKey(), value);
      // También actualiza la memoria alternativa para consistencia dentro de la sesión
      consentInMemory = value;
      return;
    } catch (e) {
      // localStorage falló, continuaremos a memoria alternativa
    }
  }

  // Fellback a memoria alternativa
  consentInMemory = value;
}

// Oculta el banner de cookies.
function hideCookieBanner() {
  const banner = document.getElementById('cookie-banner');
  if (banner) banner.classList.add('hidden');
}

// Muestra el banner de cookies y lo pone a disposición para que la persona usuaria
// pueda cambiar su decisión de consentimiento. Siempre respeta el estado guardado
// (accepted/rejected) y lo refleja en los botones.
function openPreferences() {
  const banner = document.getElementById('cookie-banner');
  if (!banner) return;

  // Aseguramos que el banner sea visible
  banner.classList.remove('hidden');

  // Refrescamos el estado de los botones según la decisión actual
  const consent = readConsent();
  const acceptBtn = banner.querySelector('[data-cookie-action="accept"]');
  const rejectBtn = banner.querySelector('[data-cookie-action="reject"]');

  if (acceptBtn && rejectBtn) {
    if (consent === 'accepted') {
      // Marcar accept como activo, reject como inactivo
      acceptBtn.setAttribute('aria-pressed', 'true');
      rejectBtn.setAttribute('aria-pressed', 'false');
    } else if (consent === 'rejected') {
      // Marcar reject como activo, accept como inactivo
      acceptBtn.setAttribute('aria-pressed', 'false');
      rejectBtn.setAttribute('aria-pressed', 'true');
    } else {
      // Sin decisión guardada: ambos en estado neutro
      acceptBtn.removeAttribute('aria-pressed');
      rejectBtn.removeAttribute('aria-pressed');
    }
  }
}

// Muestra el banner de cookies.
function showCookieBanner() {
  const banner = document.getElementById('cookie-banner');
  if (banner) banner.classList.remove('hidden');
}

// Telemetry provider configuration from site config.
const telemetryProvider = window.__SITE_CONFIG__?.telemetry?.provider;

// Map of configured providers to their script sources.
const providerScripts = {
  gtag: 'https://www.googletagmanager.com/gtag/js?id=',
};

// State tracking for session-level telemetry control.
let telemetryLoaded = false;
let telemetryEventSent = false;

/**
 * loadTelemetry() — Inicializa la telemetría solo cuando hay consentimiento vigente,
 * solo para el proveedor configurado y una sola vez por sesión.
 * No carga nada antes de la decisión del usuario.
 */
function loadTelemetry() {
  // Ya cargado esta sesión: nothing.
  if (telemetryLoaded) return;

  const consent = readConsent();
  if (consent !== 'accepted') return;

  const configTelemetry = window.__SITE_CONFIG__?.telemetry;
  if (!configTelemetry || !configTelemetry.id) return;

  const provider = configTelemetry.provider || telemetryProvider || 'gtag';
  const scriptSrc = (providerScripts && providerScripts[provider]) || providerScripts.gtag;
  const telemetryId = configTelemetry.id;

  // Evitar cargar dos veces el mismo proveedor.
  if (document.querySelector(`script[data-telemetry-script="true"][data-provider="${provider}"]`)) {
    telemetryLoaded = true;
    return;
  }

  const script = document.createElement('script');
  script.src = `${scriptSrc}${telemetryId}`;
  script.async = true;
  script.setAttribute('data-telemetry-script', 'true');
  script.setAttribute('data-provider', provider);
  document.head.appendChild(script);

  telemetryLoaded = true;
}

// R38: la configuración llega de forma asíncrona (app.js la aplica tras el primer fetch), así que
// el intento de DOMContentLoaded veía window.__SITE_CONFIG__ undefined y se quedaba sin cargar el
// proveedor. Este escucha se registra a nivel de módulo, durante la ejecución diferida del script,
// siempre antes de que la configuración termine de llegar: en cuanto app.js la aplica (carga
// inicial o reintento) y hay consentimiento guardado, se inicializa el proveedor. loadTelemetry
// comprueba por su parte consentimiento y evita duplicados.
document.addEventListener('siteconfigready', () => {
  if (readConsent() === 'accepted') loadTelemetry();
});

/**
 * trackEvent(eventName, payload) — Envía un evento de telemetría al dataLayer.
 * Solo se envía una vez por sesión y solo si hay consentimiento vigente.
 */
function trackEvent(eventName, payload = {}) {
  // Solo si hay consentimiento aceptado y aún no se envió un evento esta sesión.
  if (telemetryEventSent) return;
  if (readConsent() !== 'accepted') return;

  const telemetry = window.__SITE_CONFIG__?.telemetry;
  if (!telemetry || !telemetry.id) return;

  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event: eventName, ...payload });

  telemetryEventSent = true;
}

// Manejar la decisión del usuario en el banner de cookies.
// Almacena la decisión usando readConsent/writeConsent con alternativa de memoria.
function handleConsent(choice) {
  const accepted = choice === 'accept';
  writeConsent(accepted ? 'accepted' : 'rejected');

  if (accepted) {
    loadTelemetry();
    trackEvent('cookie_consent', { status: 'accepted' });
  } else {
    // Consentimiento rechazado: asegurarse de que no queden cargas pendientes.
    telemetryLoaded = false;
    telemetryEventSent = false;
    // Remover cualquier script de telemetría que se haya cargado previamente
    // en esta sesión (solo si el usuario cambia de decisión después de aceptar).
    const existingScript = document.querySelector('script[data-telemetry-script="true"]');
    if (existingScript) {
      existingScript.remove();
    }
  }

  // El banner queda oculto tras la decisión. openPreferences() solo se invoca
  // desde el enlace «Preferencias» del pie: si se llamara aquí, reabriría el
  // banner (remove('hidden')) justo después de ocultarlo y el usuario vería
  // que no desaparece.
  hideCookieBanner();
}

// Al cargar la página, decidir si mostrar el banner basándonos en readConsent.
// Si el almacenamiento está bloqueado, la decisión se conserva en memoria durante
// la sesión, pero el banner reaparecerá en la visita siguiente.
document.addEventListener('DOMContentLoaded', () => {
  const banner = document.getElementById('cookie-banner');
  if (!banner) return;

  const consent = readConsent();

  if (consent === 'accepted') {
    hideCookieBanner();
    loadTelemetry();
  } else if (consent === 'rejected') {
    // Consentimiento rechazado: se oculta el banner pero no se cargan analíticas
    // y no se hacen peticiones de telemetría.
    telemetryLoaded = false;
    telemetryEventSent = false;
    hideCookieBanner();
  } else {
    // Sin consentimiento guardado (o almacenamiento bloqueado): mostrar banner
    showCookieBanner();
  }

  banner.querySelectorAll('[data-cookie-action]').forEach((button) => {
    button.addEventListener('click', () => {
      handleConsent(button.dataset.cookieAction);
    });
  });

  // Disparador de preferencias desde el pie de página
  document.querySelectorAll('[data-open-preferences]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      openPreferences();
    });
  });
});