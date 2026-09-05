/**
 * Spiegelt CHAT_HISTORY_TURNS aus lib/prompt.js. Der Wert steht doppelt, weil
 * prompt.js im Service Worker läuft und diese Datei im Content-Script-Bundle -
 * der Test in test/chat.mjs hält beide Stellen gleich.
 */
export const CHAT_HISTORY_TURNS = 3;
