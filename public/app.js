// @ts-check
import {
  DEFAULT_MAX_BODY_BYTES,
  MAX_HISTORY_ITEMS,
  MAX_MESSAGE_CHARS,
  buildBoundedChatBody,
  checkHealth,
  getLocalTimeZone,
  sendChatRequest, memoryRequest, validConversation, validChatEvent, memoryId, MemoryApiError,
} from './api.js';

export { MAX_MESSAGE_CHARS };

/**
 * @typedef {Object} ThreadUserEntry
 * @property {string} id
 * @property {'user'} kind
 * @property {string} text
 * @property {string} timestamp
 * @property {string} [timezone]
 */

/**
 * @typedef {Object} ThreadLoadingEntry
 * @property {string} id
 * @property {'loading'} kind
 * @property {string} messageText
 * @property {string} [progress]
 */

/**
 * @typedef {Object} ThreadNoticeEntry
 * @property {string} id
 * @property {'notice'} kind
 * @property {'warning' | 'error' | 'info'} tone
 * @property {string} title
 * @property {string} subtitle
 * @property {string} pill
 * @property {string} body
 * @property {string} retryPrompt
 * @property {import('./api.js').ChatHistoryItem[]} retryHistory
 * @property {{ code?: string, requestId?: string, conversationId?: string, status?: number, details?: Array<{ path: string, message: string }>, rawPayload?: Record<string, unknown> }} telemetry
 */

/**
 * @typedef {Object} ThreadAssistantEntry
 * @property {string} id
 * @property {'assistant'} kind
 * @property {string} text
 * @property {string} timestamp
 * @property {import('../src/contracts.js').ChatResult} [result]
 * @property {string} [receiptStatus]
 * @property {{conversationId: string, turnId: string, attemptId: string}} [receipt]
 */

/**
 * @typedef {ThreadUserEntry | ThreadLoadingEntry | ThreadNoticeEntry | ThreadAssistantEntry} ThreadEntry
 */

/**
 * @typedef {Object} SessionRecord
 * @property {string} id
 * @property {string} title
 * @property {ThreadEntry[]} entries
 * @property {import('./api.js').ChatHistoryItem[]} history
 * @property {number} omittedHistoryCount
 */

/**
 * Formats a timestamp for display in local human-readable form.
 * @param {string} isoTimestamp
 * @returns {string}
 */
function formatLocalTime(isoTimestamp) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp;
  }
  try {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return isoTimestamp;
  }
}

/**
 * Builds a concise session label from the first submitted prompt.
 * @param {string} text
 * @returns {string}
 */
function buildSessionTitle(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return 'Untitled session';
  }
  return collapsed.length > 42 ? `${collapsed.slice(0, 39)}...` : collapsed;
}

/**
 * Generates an identifier matching /^[a-zA-Z0-9_-]+$/.
 * @param {string} prefix
 * @returns {string}
 */
function defaultIdGenerator(prefix) {
  const randomUuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${randomUuid}`;
}

/**
 * Creates a DOM element with optional className and textContent (never innerHTML).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {Document} doc
 * @param {K} tag
 * @param {string} [className]
 * @param {string} [textContent]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(doc, tag, className, textContent) {
  const node = doc.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (typeof textContent === 'string') {
    node.textContent = textContent;
  }
  return node;
}

/**
 * Builds a small inline SVG icon safely without HTML strings.
 * @param {Document} doc
 * @param {string} pathData
 * @param {number} [size]
 * @returns {SVGSVGElement}
 */
function svgIcon(doc, pathData, size = 16) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const path = doc.createElementNS(svgNs, 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.85');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  return svg;
}

/**
 * Copies plain text to clipboard when available, returning whether copy succeeded.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyTextSafely(text) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Initializes the Recall Agent web interface against existing DOM markup.
 * @param {{
 *   root?: Document,
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date,
 *   generateId?: (prefix: string) => string,
 *   maxHistoryItems?: number,
 *   maxBodyBytes?: number,
 *   persistence?: boolean,
 * }} [options]
 */
export function createChatApp(options = {}) {
  const doc = options.root ?? document;
  const win = doc.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? defaultIdGenerator;
  const maxHistoryItems = options.maxHistoryItems ?? MAX_HISTORY_ITEMS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const listenerController = new AbortController();
  const persistence = options.persistence !== false;
  // This option controls browser restoration, not the backend's storage policy.
  for (const badge of doc.querySelectorAll('.session-scope-badge, #topbar-session-tag, .preview-badge, .thread-meta-badge')) {
    badge.textContent = persistence ? 'Local server storage' : 'Browser session · restoration off';
  }
  if (!persistence) {
    const disclosure = doc.querySelector('.preview-banner-copy');
    if (disclosure) disclosure.textContent = 'This view lasts for this browser session; the server may still save submitted messages and source snapshots locally. Automatic conversation restoration is off.';
  }
  let memoryBusy = false; let navigation = 0;
  /** @type {AbortController | undefined} */ let loadController;
  /** @type {Map<string, {key: string, attemptKey: string}>} */ const submissions = new Map();
  /** @type {Set<string>} */ const remoteSessions = new Set();
  const memoryStatus = el(doc, 'div', 'memory-status'); memoryStatus.setAttribute('role', 'status');
  const memoryKey = 'recall.activeConversation.v1';
  /** @param {string | null} id */
  function remember(id) { try { if (id) win?.localStorage.setItem(memoryKey, id); else win?.localStorage.removeItem(memoryKey); }
    catch { memoryStatus.textContent = 'This browser cannot save the active conversation ID. Server history is still retained.'; } }
  /** @param {string} path @param {{method?: string, body?: object, signal?: AbortSignal}} [extra] */
  const stored = (path, extra = {}) => memoryRequest(path, { fetchImpl, signal: listenerController.signal, ...extra });

  const appShell = /** @type {HTMLElement | null} */ (doc.getElementById('app-shell'));
  const sidebarEl = /** @type {HTMLElement | null} */ (doc.getElementById('sidebar'));
  const sidebarBackdrop = /** @type {HTMLElement | null} */ (doc.getElementById('sidebar-backdrop'));
  const sidebarToggleBtn = /** @type {HTMLButtonElement | null} */ (
    doc.getElementById('sidebar-toggle-btn')
  );
  const sidebarCloseBtn = /** @type {HTMLButtonElement | null} */ (
    doc.getElementById('sidebar-close-btn')
  );
  const newChatBtn = /** @type {HTMLButtonElement | null} */ (doc.getElementById('new-chat-btn'));
  const mobileNewChatBtn = /** @type {HTMLButtonElement | null} */ (
    doc.getElementById('mobile-new-chat-btn')
  );
  const sessionListEl = /** @type {HTMLElement | null} */ (doc.getElementById('session-list'));
  const aboutStatusBtn = /** @type {HTMLButtonElement | null} */ (
    doc.getElementById('about-status-btn')
  );
  const apiInfoPanel = /** @type {HTMLElement | null} */ (doc.getElementById('api-info-panel'));
  const apiInfoMeta = /** @type {HTMLElement | null} */ (doc.getElementById('api-info-meta'));
  const closeApiInfoBtn = /** @type {HTMLButtonElement | null} */ (
    doc.getElementById('close-api-info-btn')
  );
  const connectionDot = /** @type {HTMLElement | null} */ (doc.getElementById('connection-dot'));
  const connectionText = /** @type {HTMLElement | null} */ (doc.getElementById('connection-text'));
  const welcomeView = /** @type {HTMLElement | null} */ (doc.getElementById('welcome-view'));
  const threadView = /** @type {HTMLElement | null} */ (doc.getElementById('thread-view'));
  const threadConversationIdEl = /** @type {HTMLElement | null} */ (
    doc.getElementById('thread-conversation-id')
  );
  const omittedHistoryNoteEl = /** @type {HTMLElement | null} */ (
    doc.getElementById('omitted-history-note')
  );
  const messageListEl = /** @type {HTMLElement | null} */ (doc.getElementById('message-list'));
  const liveStatusEl = /** @type {HTMLElement | null} */ (doc.getElementById('live-status'));
  const composerForm = /** @type {HTMLFormElement | null} */ (doc.getElementById('composer-form'));
  const chatInput = /** @type {HTMLTextAreaElement | null} */ (doc.getElementById('chat-input'));
  const composerErrorEl = /** @type {HTMLElement | null} */ (doc.getElementById('composer-error'));
  const charCounter = /** @type {HTMLElement | null} */ (doc.getElementById('char-counter'));
  const sendButton = /** @type {HTMLButtonElement | null} */ (doc.getElementById('send-button'));
  const mainCanvasEl = /** @type {HTMLElement | null} */ (doc.getElementById('main-canvas'));
  const composerDockEl = /** @type {HTMLElement | null} */ (doc.querySelector('.composer-dock'));

  if (
    !appShell ||
    !composerForm ||
    !chatInput ||
    !sendButton ||
    !welcomeView ||
    !threadView ||
    !messageListEl
  ) {
    throw new Error('Required Recall Agent UI elements are missing from DOM.');
  }

  /** @type {SessionRecord[]} */
  const sessions = [];

  /** @returns {SessionRecord} */
  function makeBlankSession() {
    return {
      id: generateId('sess'),
      title: 'New conversation',
      entries: [],
      history: [],
      omittedHistoryCount: 0,
    };
  }

  /** @type {SessionRecord} */
  let activeSession = makeBlankSession();
  /** @type {{ controller: AbortController, sessionId: string, requestToken: number, abortReason: 'user' | 'navigation' | null } | null} */
  let activeRequest = null;
  let nextRequestToken = 0;
  /** @type {Set<string>} */
  const expandedTelemetryIds = new Set();
  /** @type {Map<string, { open: boolean, scrollTop: number }>} */
  const sourcePanelState = new Map();
  /** @type {HTMLElement | null} */
  let drawerReturnFocusEl = null;
  let isUserNearBottom = true;
  const SCROLL_THRESHOLD_PX = 120;

  /**
   * Resolves the active scroll container for the conversation workspace.
   * Prioritizes any scrollable message ancestor; falls back to document scrolling element.
   * @returns {HTMLElement}
   */
  function getScrollContainer() {
    let el = messageListEl?.parentElement;
    while (el && el !== doc.body && el !== doc.documentElement) {
      if (el.scrollHeight > el.clientHeight) {
        const style = win?.getComputedStyle ? win.getComputedStyle(el) : null;
        const overflowY = style?.overflowY || '';
        if (overflowY === 'auto' || overflowY === 'scroll') {
          return /** @type {HTMLElement} */ (el);
        }
      }
      el = el.parentElement;
    }
    return /** @type {HTMLElement} */ (doc.scrollingElement || doc.documentElement || doc.body);
  }

  /**
   * Determines whether the user is scrolled near the bottom of the conversation.
   * @returns {boolean}
   */
  function isNearBottom() {
    const container = getScrollContainer();
    const isRoot = container === doc.documentElement || container === doc.body || container === doc.scrollingElement;
    const scrollHeight = isRoot
      ? Math.max(doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0)
      : container.scrollHeight;
    const clientHeight = isRoot
      ? (win?.innerHeight || doc.documentElement?.clientHeight || 0)
      : container.clientHeight;
    const scrollTop = isRoot
      ? (win?.scrollY ?? doc.documentElement?.scrollTop ?? doc.body?.scrollTop ?? 0)
      : container.scrollTop;

    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    return distanceFromBottom <= SCROLL_THRESHOLD_PX;
  }

  /**
   * Scrolls the conversation container to the bottom without page jitter or smooth-scroll delay.
   * @param {{ force?: boolean }} [scrollOptions]
   */
  function scrollToBottom(scrollOptions = {}) {
    if (!scrollOptions.force && !isUserNearBottom) {
      return;
    }
    const container = getScrollContainer();
    const isRoot = container === doc.documentElement || container === doc.body || container === doc.scrollingElement;
    if (isRoot) {
      const targetY = Math.max(doc.documentElement?.scrollHeight || 0, doc.body?.scrollHeight || 0);
      if (typeof win?.scrollTo === 'function') {
        win.scrollTo(0, targetY);
      }
      if (doc.documentElement) {
        doc.documentElement.scrollTop = targetY;
      }
      if (doc.body) {
        doc.body.scrollTop = targetY;
      }
    } else {
      container.scrollTop = container.scrollHeight;
    }
    isUserNearBottom = true;
  }

  /**
   * Synchronizes the bottom padding of the conversation canvas with the height
   * of the floating composer dock so the latest message is never obscured.
   */
  function syncComposerClearance() {
    if (!mainCanvasEl) return;
    const dockHeight = composerDockEl ? composerDockEl.offsetHeight : 0;
    const padding = Math.max(164, dockHeight + 24);
    mainCanvasEl.style.paddingBottom = `${padding}px`;
  }

  /** @param {string} message */
  function announce(message) {
    if (liveStatusEl) {
      liveStatusEl.textContent = message;
    }
  }

  /** @param {string} message */
  function showComposerError(message) {
    if (!composerErrorEl) {
      return;
    }
    if (message) {
      composerErrorEl.textContent = message;
      composerErrorEl.hidden = false;
    } else {
      composerErrorEl.textContent = '';
      composerErrorEl.hidden = true;
    }
  }

  function isCompactViewport() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(max-width: 960px)').matches;
  }

  let lastCompactViewport = isCompactViewport();

  function isSidebarVisible() {
    if (!appShell) {
      return false;
    }
    return isCompactViewport()
      ? appShell.classList.contains('drawer-open')
      : !appShell.classList.contains('sidebar-collapsed');
  }

  /**
   * Moves keyboard focus safely out of a closed/inert sidebar without trapping it offscreen.
   * @param {HTMLElement | null} [preferredTarget]
   */
  function relocateFocusFromSidebar(preferredTarget = null) {
    if (!sidebarEl) {
      return;
    }
    const activeEl = doc.activeElement;
    if (!activeEl || !sidebarEl.contains(activeEl)) {
      return;
    }
    if (
      preferredTarget &&
      preferredTarget.isConnected &&
      !sidebarEl.contains(preferredTarget) &&
      typeof preferredTarget.focus === 'function'
    ) {
      preferredTarget.focus();
      return;
    }
    const fallback =
      sidebarToggleBtn && !sidebarEl.contains(sidebarToggleBtn) ? sidebarToggleBtn : chatInput;
    fallback?.focus?.();
  }

  /**
   * Synchronizes inert, aria-hidden, and aria-expanded across desktop and compact viewports.
   * @param {{ focusTarget?: HTMLElement | null }} [syncOptions]
   */
  function syncSidebarAccessibility(syncOptions = {}) {
    const visible = isSidebarVisible();
    if (!visible) {
      relocateFocusFromSidebar(syncOptions.focusTarget ?? null);
    }

    if (sidebarEl) {
      sidebarEl.inert = !visible;
      if (visible) {
        sidebarEl.removeAttribute('inert');
      } else {
        sidebarEl.setAttribute('inert', '');
      }
      sidebarEl.setAttribute('aria-hidden', String(!visible));
    }

    if (sidebarToggleBtn) {
      sidebarToggleBtn.setAttribute('aria-expanded', String(visible));
    }

    if (sidebarBackdrop) {
      const backdropActive = isCompactViewport() && visible;
      sidebarBackdrop.setAttribute('aria-hidden', String(!backdropActive));
    }
  }

  function focusSidebarControl() {
    if (isCompactViewport() && sidebarCloseBtn) {
      sidebarCloseBtn.focus();
      return;
    }
    newChatBtn?.focus();
  }

  /**
   * @param {{ restoreFocus?: boolean, focusTarget?: HTMLElement | null }} [closeOptions]
   */
  function closeMobileDrawer(closeOptions = {}) {
    if (!appShell) {
      return;
    }
    const wasDrawerOpen = appShell.classList.contains('drawer-open');
    appShell.classList.remove('drawer-open');

    const restoreTarget =
      closeOptions.focusTarget !== undefined
        ? closeOptions.focusTarget
        : closeOptions.restoreFocus !== false
          ? (drawerReturnFocusEl ?? sidebarToggleBtn)
          : null;

    if (wasDrawerOpen && closeOptions.restoreFocus !== false && restoreTarget) {
      syncSidebarAccessibility({ focusTarget: restoreTarget });
      if (restoreTarget.isConnected && !sidebarEl?.contains(restoreTarget)) {
        restoreTarget.focus();
      }
    } else {
      syncSidebarAccessibility({ focusTarget: restoreTarget });
    }

    if (!isSidebarVisible()) {
      drawerReturnFocusEl = null;
    }
  }

  function toggleSidebar() {
    if (!appShell || !sidebarToggleBtn) {
      return;
    }
    if (isCompactViewport()) {
      const opening = !appShell.classList.contains('drawer-open');
      if (opening) {
        const currentFocus = doc.activeElement;
        drawerReturnFocusEl =
          currentFocus instanceof HTMLElement && !sidebarEl?.contains(currentFocus)
            ? currentFocus
            : sidebarToggleBtn;
        appShell.classList.add('drawer-open');
        syncSidebarAccessibility();
        focusSidebarControl();
      } else {
        closeMobileDrawer({ restoreFocus: true });
      }
    } else {
      const collapsing = !appShell.classList.contains('sidebar-collapsed');
      if (collapsing) {
        const currentFocus = doc.activeElement;
        drawerReturnFocusEl =
          currentFocus instanceof HTMLElement && !sidebarEl?.contains(currentFocus)
            ? currentFocus
            : sidebarToggleBtn;
        appShell.classList.add('sidebar-collapsed');
        syncSidebarAccessibility({ focusTarget: drawerReturnFocusEl ?? sidebarToggleBtn });
      } else {
        appShell.classList.remove('sidebar-collapsed');
        syncSidebarAccessibility();
        focusSidebarControl();
      }
    }
  }

  function handleViewportChange() {
    syncComposerClearance();
    const compactNow = isCompactViewport();
    if (compactNow === lastCompactViewport) {
      syncSidebarAccessibility();
      if (isUserNearBottom) {
        scrollToBottom();
      }
      return;
    }
    lastCompactViewport = compactNow;
    appShell?.classList.remove('drawer-open');
    drawerReturnFocusEl = null;
    syncSidebarAccessibility({ focusTarget: compactNow ? sidebarToggleBtn : chatInput });
    if (isUserNearBottom) {
      scrollToBottom();
    }
  }

  function syncTextareaHeight() {
    if (!chatInput) {
      return;
    }
    chatInput.style.height = 'auto';
    const nextHeight = Math.min(Math.max(chatInput.scrollHeight, 44), 180);
    chatInput.style.height = `${nextHeight}px`;
    syncComposerClearance();
    if (isUserNearBottom) {
      scrollToBottom();
    }
  }

  function syncComposerControls() {
    if (!chatInput || !sendButton || !composerForm) {
      return;
    }
    const raw = chatInput.value;
    const trimmed = raw.trim();
    const isOverLimit = raw.length > MAX_MESSAGE_CHARS;
    const isLocked = activeRequest !== null || memoryBusy;

    if (charCounter) {
      charCounter.textContent = `${raw.length.toLocaleString('en-US')} / ${MAX_MESSAGE_CHARS.toLocaleString('en-US')}`;
      charCounter.classList.toggle('is-over', isOverLimit);
    }

    chatInput.disabled = isLocked;
    composerForm.classList.toggle('is-submitting', isLocked);
    sendButton.disabled = isLocked || trimmed.length === 0 || isOverLimit;
  }

  function persistActiveSessionInList() {
    if (activeSession.entries.length === 0) {
      return;
    }
    const exists = sessions.some((item) => item.id === activeSession.id);
    if (!exists) {
      sessions.unshift(activeSession);
    }
  }

  function renderSessionList() {
    if (!sessionListEl) {
      return;
    }
    sessionListEl.replaceChildren();
    if (persistence) {
      const refresh = el(doc, 'button', 'btn-primary-sm', 'Refresh conversations');
      refresh.addEventListener('click', () => { void refreshConversations(); }); sessionListEl.appendChild(refresh);
    }

    if (sessions.length === 0) {
      sessionListEl.appendChild(
        el(
          doc,
          'p',
          'session-empty-note',
          persistence ? 'No stored conversations loaded. Submitted messages are saved locally on this server.' : 'This view lasts for this browser session; the server may still save submitted messages.',
        ),
      );
      return;
    }

    for (const item of sessions) {
      const button = el(doc, 'button', 'session-item-btn', item.title);
      button.type = 'button';
      if (item.id === activeSession.id) {
        button.setAttribute('aria-current', 'page');
      }
      button.addEventListener('click', () => {
        if (persistence && remoteSessions.has(item.id)) { void openConversation(item.id); return; }
        if (item.id === activeSession.id) {
          closeMobileDrawer({ restoreFocus: false, focusTarget: chatInput });
          chatInput?.focus({ preventScroll: true });
          return;
        }
        abortActiveRequest('navigation');
        activeSession = item;
        showComposerError('');
        closeMobileDrawer({ restoreFocus: false, focusTarget: chatInput });
        isUserNearBottom = true;
        renderWorkspace();
        scrollToBottom({ force: true });
        chatInput?.focus({ preventScroll: true });
        announce(`Switched to session ${item.title}`);
      });
      sessionListEl.appendChild(button);
    }
  }

  /**
   * @param {ThreadUserEntry} entry
   * @returns {HTMLElement}
   */
  function renderUserTurn(entry) {
    const article = el(doc, 'article', 'turn-user');
    article.dataset.entryId = entry.id;

    const meta = el(doc, 'div', 'turn-meta');
    meta.appendChild(el(doc, 'span', '', 'You'));
    meta.appendChild(el(doc, 'span', '', '·'));
    meta.appendChild(el(doc, 'span', '', formatLocalTime(entry.timestamp)));
    if (entry.timezone) {
      meta.appendChild(el(doc, 'span', '', `(${entry.timezone})`));
    }
    article.appendChild(meta);

    const bubble = el(doc, 'div', 'user-bubble');
    bubble.appendChild(el(doc, 'p', 'user-message-text', entry.text));
    article.appendChild(bubble);

    const retained = el(doc, 'div', 'turn-retained');
    retained.appendChild(svgIcon(doc, 'M5 13L9 17L19 7', 13));
    retained.appendChild(el(doc, 'span', '', persistence ?
      (memoryId(entry.id) ? 'Saved locally on this server' : 'Submission pending · local save not confirmed') :
      'Browser session · server may still save submitted messages'));
    article.appendChild(retained);

    return article;
  }

  /**
   * @param {ThreadLoadingEntry} entry
   * @returns {HTMLElement}
   */
  function renderLoadingTurn(entry) {
    const article = el(doc, 'article', 'turn-system');
    article.dataset.entryId = entry.id;

    const identity = el(doc, 'div', 'agent-identity');
    identity.appendChild(el(doc, 'div', 'agent-avatar', 'R'));
    identity.appendChild(el(doc, 'span', 'agent-name', 'Recall Agent'));
    identity.appendChild(el(doc, 'span', 'agent-tag', 'Request in flight'));
    article.appendChild(identity);

    const card = el(doc, 'div', 'loading-card');
    card.setAttribute('role', 'status');

    const top = el(doc, 'div', 'loading-top');
    const titleRow = el(doc, 'div', 'loading-title-row');

    const dots = el(doc, 'span', 'loading-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.appendChild(el(doc, 'span', 'loading-dot'));
    dots.appendChild(el(doc, 'span', 'loading-dot'));
    dots.appendChild(el(doc, 'span', 'loading-dot'));
    titleRow.appendChild(dots);

    titleRow.appendChild(el(doc, 'span', 'loading-label', entry.progress || 'Sending request to Recall Agent…'));
    top.appendChild(titleRow);

    const cancelBtn = el(doc, 'button', 'btn-danger-ghost', 'Cancel request');
    cancelBtn.type = 'button';
    cancelBtn.dataset.action = 'cancel-request';
    cancelBtn.addEventListener('click', () => {
      abortActiveRequest();
    });
    top.appendChild(cancelBtn);

    card.appendChild(top);
    card.appendChild(
      el(
        doc,
        'p',
        'loading-subtext',
        `Submitting "${buildSessionTitle(entry.messageText)}" to POST /api/chat…`,
      ),
    );

    article.appendChild(card);
    return article;
  }

  /**
   * @param {ThreadNoticeEntry} entry
   * @returns {HTMLElement}
   */
  function renderNoticeTurn(entry) {
    const article = el(doc, 'article', 'turn-system');
    article.dataset.entryId = entry.id;

    const identity = el(doc, 'div', 'agent-identity');
    identity.appendChild(el(doc, 'div', 'agent-avatar', 'R'));
    identity.appendChild(el(doc, 'span', 'agent-name', 'Recall Agent'));
    identity.appendChild(
      el(
        doc,
        'span',
        'agent-tag',
        entry.tone === 'error' ? 'Connection / Error' : 'System Status',
      ),
    );
    article.appendChild(identity);

    const card = el(doc, 'div', 'notice-card');
    card.setAttribute('role', 'status');

    const barTone =
      entry.tone === 'error' ? 'is-error' : entry.tone === 'warning' ? 'is-warning' : 'is-info';
    card.appendChild(el(doc, 'div', `notice-accent-bar ${barTone}`));

    const header = el(doc, 'div', 'notice-header');
    const titleGroup = el(doc, 'div', 'notice-title-group');

    const iconBox = el(doc, 'div', `notice-icon ${barTone}`);
    const iconPath =
      entry.tone === 'error'
        ? 'M12 9V13M12 17H12.01M10.29 3.86L1.82 18A2 2 0 0 0 3.53 21H20.47A2 2 0 0 0 22.18 18L13.71 3.86A2 2 0 0 0 10.29 3.86Z'
        : 'M12 9V13M12 17H12.01M21 12A9 9 0 1 1 3 12A9 9 0 0 1 21 12Z';
    iconBox.appendChild(svgIcon(doc, iconPath, 16));
    titleGroup.appendChild(iconBox);

    const headingStack = el(doc, 'div');
    headingStack.appendChild(el(doc, 'h2', 'notice-heading', entry.title));
    headingStack.appendChild(el(doc, 'div', 'notice-subheading', entry.subtitle));
    titleGroup.appendChild(headingStack);

    header.appendChild(titleGroup);
    header.appendChild(el(doc, 'span', 'http-pill', entry.pill));
    card.appendChild(header);

    card.appendChild(el(doc, 'p', 'notice-copy', entry.body));

    if (entry.telemetry.details && entry.telemetry.details.length > 0) {
      const list = el(doc, 'ul', 'validation-list');
      for (const detail of entry.telemetry.details) {
        list.appendChild(el(doc, 'li', '', `${detail.path || 'request'}: ${detail.message}`));
      }
      card.appendChild(list);
    }

    if (entry.telemetry.code || entry.telemetry.requestId || entry.telemetry.conversationId) {
      const telemetryBox = el(doc, 'div', 'telemetry-box');
      const telemetryTop = el(doc, 'div', 'telemetry-top');
      telemetryTop.appendChild(el(doc, 'span', 'telemetry-label', 'Response telemetry'));

      const isExpanded = expandedTelemetryIds.has(entry.id);
      const toggleBtn = el(
        doc,
        'button',
        'telemetry-toggle-btn',
        isExpanded ? 'Hide payload' : 'Show payload',
      );
      toggleBtn.type = 'button';
      toggleBtn.setAttribute('aria-expanded', String(isExpanded));

      const pre = el(
        doc,
        'pre',
        'telemetry-pre',
        JSON.stringify(
          entry.telemetry.rawPayload ?? {
            status: entry.telemetry.status,
            code: entry.telemetry.code,
            requestId: entry.telemetry.requestId,
            conversationId: entry.telemetry.conversationId,
          },
          null,
          2,
        ),
      );
      pre.hidden = !isExpanded;

      toggleBtn.addEventListener('click', () => {
        const nextExpanded = pre.hidden;
        pre.hidden = !nextExpanded;
        toggleBtn.setAttribute('aria-expanded', String(nextExpanded));
        toggleBtn.textContent = nextExpanded ? 'Hide payload' : 'Show payload';
        if (nextExpanded) {
          expandedTelemetryIds.add(entry.id);
        } else {
          expandedTelemetryIds.delete(entry.id);
        }
      });

      telemetryTop.appendChild(toggleBtn);
      telemetryBox.appendChild(telemetryTop);

      const summary = el(doc, 'div', 'telemetry-summary');
      if (entry.telemetry.code) {
        summary.appendChild(el(doc, 'span', '', `code=${entry.telemetry.code}`));
      }
      if (entry.telemetry.requestId) {
        summary.appendChild(el(doc, 'span', '', `requestId=${entry.telemetry.requestId}`));
      }
      if (entry.telemetry.conversationId) {
        summary.appendChild(el(doc, 'span', '', `conversationId=${entry.telemetry.conversationId}`));
      }
      telemetryBox.appendChild(summary);
      telemetryBox.appendChild(pre);
      card.appendChild(telemetryBox);
    }

    const guarantee = el(doc, 'div', 'retained-guarantee');
    guarantee.appendChild(svgIcon(doc, 'M5 13L9 17L19 7', 14));
    guarantee.appendChild(
      el(doc, 'span', '', 'Your message remains visible here and may already be saved locally on this server. Refresh conversations to check stored state.'),
    );
    card.appendChild(guarantee);

    const actions = el(doc, 'div', 'notice-actions');
    const btnGroup = el(doc, 'div', 'notice-btn-group');

    const retryBtn = el(doc, 'button', 'btn-primary-sm', 'Retry request');
    retryBtn.type = 'button';
    retryBtn.dataset.action = 'retry-request';
    retryBtn.disabled = activeRequest !== null;
    retryBtn.addEventListener('click', () => {
      void retryNoticeEntry(entry);
    });
    btnGroup.appendChild(retryBtn);

    const copyText = JSON.stringify(
      {
        title: entry.title,
        pill: entry.pill,
        body: entry.body,
        telemetry: entry.telemetry.rawPayload ?? entry.telemetry,
      },
      null,
      2,
    );
    const copyBtn = el(doc, 'button', 'btn-secondary', 'Copy details');
    copyBtn.type = 'button';
    const copyNote = el(doc, 'span', 'notice-status-note', '');
    copyBtn.addEventListener('click', async () => {
      const copied = await copyTextSafely(copyText);
      copyNote.textContent = copied ? 'Copied to clipboard' : 'Clipboard unavailable';
    });
    btnGroup.appendChild(copyBtn);

    actions.appendChild(btnGroup);
    actions.appendChild(copyNote);
    card.appendChild(actions);

    article.appendChild(card);
    return article;
  }

  /**
   * Safely formats assistant answer text with inline bold, inline code, and clickable citations.
   * Never injects raw HTML; all text is placed in DOM text nodes.
   * Code delimiters are matching backtick runs on one line; contents stay exact.
   * Only paired standalone bold delimiters (including \*\* and \_\_) are interpreted.
   * Isolated escapes/backslashes remain literal. Bracket-escaped citations use the
   * same grammar as server/browser validation. This is deliberately inline-only.
   *
   * @param {HTMLElement} container
   * @param {string} rawText
   * @param {Map<string, import('../src/contracts.js').ChatResult['sources'][number]>} sources
   * @param {boolean} [allowBold]
   */
  function renderFormattedContent(container, rawText, sources, allowBold = true) {
    /** @param {number} start */
    const codeAt = (start) => {
      if (rawText[start] !== '`') return null;
      let width = 1;
      while (rawText[start + width] === '`') width++;
      const delimiter = '`'.repeat(width);
      let end = rawText.indexOf(delimiter, start + width);
      while (end >= 0) {
        if (rawText[end - 1] !== '`' && rawText[end + width] !== '`') {
          const content = rawText.slice(start + width, end);
          if (content.includes('\n') || content.includes('\r')) return null;
          return { content, end: end + width };
        }
        end = rawText.indexOf(delimiter, end + width);
      }
      return null;
    };
    let plain = '';
    const flush = () => { if (plain) container.appendChild(doc.createTextNode(plain)); plain = ''; };
    for (let i = 0; i < rawText.length;) {
      // Protect code before interpreting escapes, emphasis or citation markers.
      const code = codeAt(i);
      if (code) { flush(); container.appendChild(el(doc, 'code', 'code-inline', code.content)); i = code.end; continue; }
      const citation = rawText.slice(i).match(/^\\?\[(S\d+)\\?\]/);
      if (citation) {
        flush();
        const source = sources.get(citation[1]);
        if (source) {
          const link = el(doc, 'a', 'citation-link', `[${citation[1]}]`);
          link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = source.title;
          container.appendChild(link);
        } else container.appendChild(doc.createTextNode(citation[0]));
        i += citation[0].length; continue;
      }
      const delimiter = allowBold && (i === 0 || !/[\p{L}\p{N}\\/:_]/u.test(rawText[i - 1])) ?
        ['**', '__', '\\*\\*', '\\_\\_'].find((value) => rawText.startsWith(value, i)) : undefined;
      if (delimiter) {
        const start = i + delimiter.length;
        let end = start;
        while (end < rawText.length && rawText[end] !== '\n' && rawText[end] !== '\r') {
          const protectedCode = codeAt(end);
          if (protectedCode) { end = protectedCode.end; continue; }
          if (rawText.startsWith(delimiter, end)) break;
          end++;
        }
        const inner = rawText.slice(start, end);
        if (rawText.startsWith(delimiter, end) && inner.trim() && inner === inner.trim() &&
            !/[\r\n]/.test(inner) && !/[\p{L}\p{N}_]/u.test(rawText[end + delimiter.length] ?? '')) {
          flush(); const strong = el(doc, 'strong', 'answer-bold');
          renderFormattedContent(strong, inner, sources, false); container.appendChild(strong);
          i = end + delimiter.length; continue;
        }
      }
      // Preserve an unhandled escape as a pair, so its backtick cannot open code.
      const width = rawText[i] === '\\' && i + 1 < rawText.length ? 2 : 1;
      plain += rawText.slice(i, i + width); i += width;
    }
    flush();
  }

  /**
   * @param {ThreadAssistantEntry} entry
   * @returns {HTMLElement}
   */
  function renderAssistantTurn(entry) {
    const article = el(doc, 'article', 'turn-system');
    article.dataset.entryId = entry.id;

    const identity = el(doc, 'div', 'agent-identity');
    identity.appendChild(el(doc, 'div', 'agent-avatar', 'R'));
    identity.appendChild(el(doc, 'span', 'agent-name', 'Recall Agent'));
    identity.appendChild(el(doc, 'span', 'agent-tag', formatLocalTime(entry.timestamp)));
    article.appendChild(identity);

    const answerCard = el(doc, 'div', 'notice-card');
    answerCard.appendChild(el(doc, 'div', 'notice-accent-bar is-info'));
    const content = el(doc, 'div', 'assistant-answer-card');
    const sources = new Map((entry.result?.sources ?? []).map((s) => [s.id, s]));
    renderFormattedContent(content, entry.text, sources);
    answerCard.appendChild(content);
    if (entry.receiptStatus) {
      answerCard.appendChild(el(doc, 'p', 'research-limitation', entry.receiptStatus));
      if (entry.receipt && entry.result?.coverage === 'complete') {
        const recover = el(doc, 'button', 'btn-primary-sm', 'Recover / retry receipt');
        recover.dataset.action = 'recover-receipt';
        const owner = activeSession;
        recover.addEventListener('click', () => { if (activeSession === owner && owner.entries.includes(entry)) void receiveStoredAnswer(owner, entry, true); });
        answerCard.appendChild(recover);
      }
    }
    if (entry.result?.coverage === 'partial') {
      const labels = {
        search_budget_exhausted: 'Search budget reached', search_cutoff: 'Search time window ended',
        search_unavailable: 'Search unavailable', search_timeout: 'Search timed out',
        search_failed: 'Search failed', search_invalid_results: 'Search returned unusable evidence',
      };
      answerCard.appendChild(el(doc, 'p', 'research-limitation',
        `Partial research: ${entry.result.issues.map((issue) => labels[issue]).join('; ')}. This answer is not included in subsequent conversation context.`));
    }
    if (entry.result) {
      const disclosure = el(doc, 'details', 'answer-sources');
      disclosure.dataset.entryId = entry.id;
      const panelState = sourcePanelState.get(entry.id);
      disclosure.open = panelState?.open ?? false;
      disclosure.appendChild(el(doc, 'summary', '', `Sources (${sources.size})`));
      disclosure.appendChild(el(doc, 'p', 'sources-disclaimer', 'Source IDs are registry-checked. Quotation matching, when reported, is limited to available snippets; factual claims are not independently verified.'));
      const list = el(doc, 'div', 'source-list');
      for (const source of sources.values()) {
        const item = el(doc, 'div', 'source-entry');
        const link = el(doc, 'a', '', `[${source.id}] ${source.title}`);
        link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        item.appendChild(link);
        item.appendChild(el(doc, 'p', '', source.url));
        item.appendChild(el(doc, 'p', '', `Query: ${source.query}`));
        item.appendChild(el(doc, 'p', '', `Retrieved: ${source.retrieved_at}`));
        if (source.published_at) item.appendChild(el(doc, 'p', '', `Published: ${source.published_at}`));
        if (source.effective_at) item.appendChild(el(doc, 'p', '', `Effective: ${source.effective_at}`));
        list.appendChild(item);
      }
      disclosure.appendChild(list);
      let lastOpen = disclosure.open;
      disclosure.addEventListener('toggle', () => {
        if (!disclosure.isConnected || disclosure.open === lastOpen) return;
        lastOpen = disclosure.open;
        sourcePanelState.set(entry.id, { open: disclosure.open, scrollTop: list.scrollTop });
        // Expansion is reader navigation, not newly generated content. Do not move
        // the outer viewport; resume following only if it is actually near bottom.
        isUserNearBottom = isUserNearBottom && isNearBottom();
      });
      answerCard.appendChild(disclosure);
    }
    article.appendChild(answerCard);

    return article;
  }

  function renderWorkspace() {
    if (!welcomeView || !threadView || !messageListEl) {
      return;
    }
    const scrollContainer = getScrollContainer();
    const rootScroll = scrollContainer === doc.documentElement || scrollContainer === doc.body || scrollContainer === doc.scrollingElement;
    const readerTop = rootScroll ? (win?.scrollY ?? scrollContainer.scrollTop) : scrollContainer.scrollTop;
    for (const panel of messageListEl.querySelectorAll('details.answer-sources')) {
      const disclosure = /** @type {HTMLDetailsElement} */ (panel);
      const list = disclosure.querySelector('.source-list');
      if (disclosure.dataset.entryId) sourcePanelState.set(disclosure.dataset.entryId,
        { open: disclosure.open, scrollTop: list?.scrollTop ?? 0 });
    }
    const hasEntries = activeSession.entries.length > 0;
    welcomeView.hidden = hasEntries;
    threadView.hidden = !hasEntries;

    if (threadConversationIdEl) {
      threadConversationIdEl.textContent = `Session · ${activeSession.id}`;
    }

    if (omittedHistoryNoteEl) {
      if (activeSession.omittedHistoryCount > 0) {
        const count = activeSession.omittedHistoryCount;
        omittedHistoryNoteEl.hidden = false;
        omittedHistoryNoteEl.textContent = `${count} earlier session ${count === 1 ? 'message was' : 'messages were'} omitted from the API request payload to stay within backend history (100) and size (256 KB) limits; ${persistence ? 'saved turns can be restored from the server' : 'full messages remain visible in this tab only'}.`;
      } else {
        omittedHistoryNoteEl.hidden = true;
        omittedHistoryNoteEl.textContent = '';
      }
    }

    messageListEl.replaceChildren();
    for (const entry of activeSession.entries) {
      if (entry.kind === 'user') {
        messageListEl.appendChild(renderUserTurn(entry));
      } else if (entry.kind === 'loading') {
        messageListEl.appendChild(renderLoadingTurn(entry));
      } else if (entry.kind === 'notice') {
        messageListEl.appendChild(renderNoticeTurn(entry));
      } else {
        messageListEl.appendChild(renderAssistantTurn(entry));
      }
    }
    // Restore only after attachment/open-state layout: real browsers clamp a
    // detached list's scrollTop to zero, unlike DOM-only test environments.
    for (const panel of messageListEl.querySelectorAll('details.answer-sources')) {
      const disclosure = /** @type {HTMLDetailsElement} */ (panel);
      const list = disclosure.querySelector('.source-list');
      const state = sourcePanelState.get(disclosure.dataset.entryId ?? '');
      if (list && state?.open) list.scrollTop = state.scrollTop;
    }

    renderSessionList();
    syncComposerControls();
    syncComposerClearance();

    if (isUserNearBottom) scrollToBottom();
    else if (rootScroll) {
      win?.scrollTo(0, readerTop); scrollContainer.scrollTop = readerTop;
    } else scrollContainer.scrollTop = readerTop;
  }

  /**
   * Executes POST /api/chat and transforms a loading entry into the final response entry.
   * @param {SessionRecord} targetSession
   * @param {string} loadingEntryId
   * @param {string} promptText
   * @param {import('./api.js').ChatHistoryItem[]} historySnapshot
   */
  async function executeChatSubmission(targetSession, loadingEntryId, promptText, historySnapshot) {
    const loadingIndex = targetSession.entries.findIndex((item) => item.id === loadingEntryId);
    const loadingEntry = targetSession.entries[loadingIndex];
    const userEntry = targetSession.entries[loadingIndex - 1];
    if (loadingEntry?.kind !== 'loading' || userEntry?.kind !== 'user') return;
    const submission = submissions.get(userEntry.id) ?? { key: userEntry.id, attemptKey: generateId('attempt') };
    submissions.set(userEntry.id, submission);
    const requestToken = ++nextRequestToken;
    /** @type {{ controller: AbortController, sessionId: string, requestToken: number, abortReason: 'user' | 'navigation' | null }} */
    const requestState = {
      controller: new AbortController(),
      sessionId: targetSession.id,
      requestToken,
      abortReason: null,
    };
    activeRequest = requestState;
    if (persistence && !memoryId(targetSession.id)) {
      try {
        const created = await stored('/api/conversations', { method: 'POST', body: {}, signal: AbortSignal.any([requestState.controller.signal, listenerController.signal]) });
        if (!validConversation(created)) throw new Error('Invalid conversation');
        if (requestState.controller.signal.aborted) throw new Error('Cancelled');
        if (targetSession.entries.find((e) => e.id === loadingEntryId) !== loadingEntry) return;
        targetSession.id = created.id; requestState.sessionId = created.id; remoteSessions.add(created.id); remember(created.id);
      } catch {
        if (targetSession.entries.find((e) => e.id === loadingEntryId) === loadingEntry) {
          targetSession.entries.splice(loadingIndex, 1, { id: loadingEntryId, kind: 'notice', tone: 'error', title: requestState.controller.signal.aborted ? 'Request cancelled' : 'Conversation could not be created',
            subtitle: 'No model request started', pill: 'Storage unavailable', body: requestState.controller.signal.aborted ? 'Request cancelled before a model call started.' : 'Server storage could not be reached. Retry when the server is available.',
            retryPrompt: promptText, retryHistory: historySnapshot, telemetry: {} });
          if (activeSession === targetSession) renderWorkspace();
        }
        return;
      } finally { if (requestState.controller.signal.aborted || targetSession.id === requestState.sessionId && !memoryId(targetSession.id)) {
        if (activeRequest === requestState) activeRequest = null; syncComposerControls();
      } }
    }
    const timezone = getLocalTimeZone();

    const boundedPreview = buildBoundedChatBody(
      {
        conversationId: targetSession.id,
        message: promptText,
        timezone,
        history: persistence ? historySnapshot.filter((m) => m.role !== 'user' || !!m.id && memoryId(m.id)) : historySnapshot,
        ...(persistence ? { turn: submission } : {}),
      },
      { maxHistoryItems, maxBodyBytes },
    );
    targetSession.omittedHistoryCount = boundedPreview.omittedCount;
    if (boundedPreview.exceedsLimit) {
      if (activeRequest?.requestToken === requestToken) {
        activeRequest = null;
      }
      const index = targetSession.entries.findIndex((item) => item.id === loadingEntryId);
      /** @type {ThreadNoticeEntry} */
      const sizeNotice = {
        id: loadingEntryId,
        kind: 'notice',
        tone: 'error',
        title: 'Request exceeded size limit',
        subtitle: 'Local payload validation',
        pill: 'HTTP 413',
        body: `Request payload (${boundedPreview.serializedBytes.toLocaleString('en-US')} UTF-8 bytes) exceeds the ${boundedPreview.maxBodyBytes.toLocaleString('en-US')}-byte limit. Shorten your message and try again.`,
        retryPrompt: promptText,
        retryHistory: historySnapshot,
        telemetry: {
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          conversationId: targetSession.id,
        },
      };
      if (index >= 0) {
        targetSession.entries.splice(index, 1, sizeNotice);
      } else {
        targetSession.entries.push(sizeNotice);
      }
      if (activeSession.id === targetSession.id) {
        renderWorkspace();
        announce(sizeNotice.body);
      } else {
        syncComposerControls();
      }
      return;
    }
    if (activeSession.id === targetSession.id) {
      renderWorkspace();
    } else {
      syncComposerControls();
    }

    const result = await sendChatRequest(
      {
        conversationId: targetSession.id,
        message: promptText,
        timezone,
        history: persistence ? historySnapshot.filter((m) => m.role !== 'user' || !!m.id && memoryId(m.id)) : historySnapshot,
        ...(persistence ? { turn: submission } : {}),
      },
      {
        signal: requestState.controller.signal,
        fetchImpl,
        maxHistoryItems,
        maxBodyBytes,
        onProgress: (progress) => {
          if (requestState.controller.signal.aborted || activeRequest?.requestToken !== requestToken) return;
          const entry = targetSession.entries.find((item) => item.id === loadingEntryId);
          if (entry?.kind !== 'loading') return;
          entry.progress = progress.phase === 'accepted' ? 'Request accepted' :
            progress.phase === 'model_started' ? 'Waiting for the model response…' : 'Searching the web…';
          if (activeSession.id === targetSession.id) {
            const label = messageListEl?.querySelector(`[data-entry-id="${loadingEntryId}"] .loading-label`);
            if (label) label.textContent = entry.progress;
            announce(entry.progress);
            if (isUserNearBottom) {
              scrollToBottom();
            }
          }
        },
      },
    );

    let synchronized = !persistence;
    if (persistence && memoryId(targetSession.id) && !listenerController.signal.aborted && !requestState.controller.signal.aborted) {
      try {
        const value = await stored(`/api/conversations/${targetSession.id}`, { signal: AbortSignal.any([requestState.controller.signal, listenerController.signal]) });
        if (!validConversation(value) || value.id !== targetSession.id) throw new Error('Invalid conversation');
        const turn = value.turns.find((t) => t.key === submission.key);
        if (turn && targetSession.entries.find((e) => e.id === loadingEntryId) === loadingEntry) {
          const oldId = userEntry.id; const item = targetSession.history.find((m) => m.id === oldId);
          const keys = submissions.get(oldId); if (keys) { submissions.delete(oldId); submissions.set(turn.user.id, keys); }
          userEntry.id = turn.user.id; userEntry.timestamp = turn.user.timestamp; userEntry.text = turn.user.content;
          if (item) Object.assign(item, turn.user); synchronized = true;
        }
      } catch { if (!requestState.controller.signal.aborted) memoryStatus.textContent = 'Server turn state could not be synchronized. Refresh conversations before relying on this history.'; }
    }

    if (requestState.controller.signal.aborted) result.kind = 'aborted';

    // A completion owns only the loading slot that started it. A newer attempt
    // may already have replaced that slot after cancellation.
    if (targetSession.entries.find((item) => item.id === loadingEntryId) !== loadingEntry) return;
    if (activeRequest?.requestToken === requestToken) {
      activeRequest = null;
    }

    if (typeof result.omittedHistoryCount === 'number') {
      targetSession.omittedHistoryCount = result.omittedHistoryCount;
    }

    const isCurrentActiveSession = activeSession.id === targetSession.id;
    const abortedByNavigation = requestState.abortReason === 'navigation';
    const shouldAnnounceAndFocus = isCurrentActiveSession && !abortedByNavigation && activeRequest === null;

    const index = targetSession.entries.findIndex((item) => item.id === loadingEntryId);
    /** @param {ThreadEntry} replacement */
    const replaceEntry = (replacement) => {
      if (index >= 0) {
        targetSession.entries.splice(index, 1, replacement);
      } else {
        targetSession.entries.push(replacement);
      }
    };

    if (result.kind === 'ok' && result.result && !requestState.controller.signal.aborted) {
      const answer = result.result;
      /** @type {ThreadAssistantEntry} */
      const assistant = { id: loadingEntryId, kind: 'assistant', text: answer.message.content,
        timestamp: answer.message.timestamp, result: answer,
        ...(persistence ? { receipt: result.receipt, receiptStatus: answer.coverage === 'partial' ? 'Partial answer retained; it is excluded from assistant history.' : result.receipt ? 'Answer received; server receipt is pending.' : 'Receipt identifiers are missing; this answer is excluded from assistant history.' } : {}) };
      replaceEntry(assistant);
      if (persistence) {
        if (result.receipt) targetSession.id = result.receipt.conversationId;
        remoteSessions.add(targetSession.id);
        remember(result.receipt?.conversationId ?? targetSession.id);
        if (answer.coverage === 'complete' && result.receipt && synchronized) await receiveStoredAnswer(targetSession, assistant, false);
        else if (!synchronized) assistant.receiptStatus = 'Server turn identity could not be synchronized. Refresh conversations before continuing this history.';
      }
      if (!persistence && answer.coverage === 'complete' && !targetSession.history.some((item) => item.id === answer.message.id)) {
        // Completion time is not turn order: an older retry belongs immediately
        // after its original user message, before any later user/assistant turns.
        const userIndex = targetSession.history.findIndex((item) => item.id === userEntry.id && item.role === 'user');
        if (userIndex >= 0) targetSession.history.splice(userIndex + 1, 0, { ...answer.message });
      }
      if (shouldAnnounceAndFocus) announce(answer.coverage === 'complete' ? 'Answer received.' : 'Answer received with partial research.');
    } else if (result.kind === 'stream_error' || result.kind === 'protocol_error') {
      if (result.kind === 'stream_error') submissions.set(userEntry.id, { key: submission.key, attemptKey: generateId('attempt') });
      replaceEntry({ id: loadingEntryId, kind: 'notice', tone: 'error', title: 'Response could not be completed',
        subtitle: 'No assistant reply recorded', pill: 'Response error',
        body: result.message || 'The response was incomplete or invalid.', retryPrompt: promptText, retryHistory: historySnapshot,
        telemetry: { code: result.code, requestId: result.requestId, conversationId: targetSession.id } });
      if (shouldAnnounceAndFocus) announce('Response failed. No assistant reply recorded.');
    } else if (result.kind === 'not_implemented') {
      replaceEntry({
        id: loadingEntryId,
        kind: 'notice',
        tone: 'warning',
        title: 'Chat responses aren’t available yet',
        subtitle: 'Backend API connected · Agent loop pending',
        pill: 'HTTP 501',
        body:
          result.message ||
          'The interface is connected to POST /api/chat, but backend agent execution is still being implemented.',
        retryPrompt: promptText,
        retryHistory: historySnapshot,
        telemetry: {
          status: result.status ?? 501,
          code: result.code ?? 'AGENT_NOT_IMPLEMENTED',
          requestId: result.requestId,
          conversationId: result.conversationId ?? targetSession.id,
          rawPayload: {
            endpoint: 'POST /api/chat',
            status: result.status ?? 501,
            code: result.code ?? 'AGENT_NOT_IMPLEMENTED',
            message: result.message,
            requestId: result.requestId,
            conversationId: result.conversationId ?? targetSession.id,
          },
        },
      });
      if (shouldAnnounceAndFocus && activeRequest === null && activeSession === targetSession) {
        announce('Server responded with HTTP 501: agent not implemented yet.');
      }
    } else if (result.kind === 'aborted') {
      submissions.set(userEntry.id, { key: submission.key, attemptKey: generateId('attempt') });
      replaceEntry({
        id: loadingEntryId,
        kind: 'notice',
        tone: 'info',
        title: 'Request cancelled',
        subtitle: 'Aborted before server response',
        pill: 'Cancelled',
        body: 'You stopped waiting for this response. Your message remains in this browser session if you want to retry.',
        retryPrompt: promptText,
        retryHistory: historySnapshot,
        telemetry: {
          code: 'CLIENT_ABORTED',
          conversationId: targetSession.id,
        },
      });
      if (shouldAnnounceAndFocus && activeRequest === null && activeSession === targetSession) {
        announce('Chat request cancelled.');
      }
    } else if (result.kind === 'network_error') {
      replaceEntry({
        id: loadingEntryId,
        kind: 'notice',
        tone: 'error',
        title: 'Couldn’t reach the server',
        subtitle: 'Network or server availability issue',
        pill: 'Network Error',
        body:
          result.message ||
          'Couldn’t reach the server. Check that the backend is running and try again.',
        retryPrompt: promptText,
        retryHistory: historySnapshot,
        telemetry: {
          code: result.code ?? 'NETWORK_ERROR',
          conversationId: targetSession.id,
        },
      });
      if (shouldAnnounceAndFocus && activeRequest === null && activeSession === targetSession) {
        announce('Network error: could not reach server.');
        void refreshHealth();
      }
    } else if (result.kind === 'http_error') {
      const status = result.status ?? 500;
      const title =
        status === 400
          ? 'Message rejected by validation'
          : status === 413
            ? 'Request exceeded size limit'
            : status === 504
              ? 'Request deadline exceeded'
              : 'Server returned an error';
      replaceEntry({
        id: loadingEntryId,
        kind: 'notice',
        tone: 'error',
        title,
        subtitle: 'POST /api/chat error response',
        pill: `HTTP ${status}`,
        body: result.message || `Server responded with HTTP ${status}.`,
        retryPrompt: promptText,
        retryHistory: historySnapshot,
        telemetry: {
          status,
          code: result.code,
          requestId: result.requestId,
          conversationId: result.conversationId ?? targetSession.id,
          details: result.details,
          rawPayload: {
            endpoint: 'POST /api/chat',
            status,
            code: result.code,
            message: result.message,
            details: result.details,
            requestId: result.requestId,
            conversationId: result.conversationId ?? targetSession.id,
          },
        },
      });
      if (shouldAnnounceAndFocus && activeRequest === null && activeSession === targetSession) {
        announce(`Server error HTTP ${status}.`);
      }
    } else {
      // Unsupported responses never become assistant text or conversation history.
      const status = result.status ?? 200;
      replaceEntry({
        id: loadingEntryId,
        kind: 'notice',
        tone: 'info',
        title: 'Unsupported server response',
        subtitle: 'POST /api/chat protocol status',
        pill: `HTTP ${status}`,
        body:
          result.message ||
          `Server returned HTTP ${status}, which does not match an active chat response contract in this build. No assistant reply was recorded.`,
        retryPrompt: promptText,
        retryHistory: historySnapshot,
        telemetry: {
          status,
          code: result.code ?? 'UNSUPPORTED_RESPONSE_FORMAT',
          requestId: result.requestId,
          conversationId: result.conversationId ?? targetSession.id,
          rawPayload: {
            endpoint: 'POST /api/chat',
            status,
            code: result.code ?? 'UNSUPPORTED_RESPONSE_FORMAT',
            contentType: result.contentType,
            requestId: result.requestId,
            conversationId: result.conversationId ?? targetSession.id,
          },
        },
      });
      if (shouldAnnounceAndFocus && activeRequest === null && activeSession === targetSession) {
        announce(`Server returned HTTP ${status} without a supported assistant response.`);
      }
    }

    if (isCurrentActiveSession) {
      renderWorkspace();
      if (shouldAnnounceAndFocus && activeRequest === null && activeSession === targetSession) {
        chatInput?.focus({ preventScroll: true });
      }
    } else {
      syncComposerControls();
    }
  }

  /** @param {SessionRecord} session @param {ThreadAssistantEntry} entry @param {boolean} recover */
  async function receiveStoredAnswer(session, entry, recover) {
    const refs = entry.receipt; if (!refs || !entry.result || entry.result.coverage !== 'complete') return;
    const version = navigation;
    const base = `/api/conversations/${refs.conversationId}/turns/${refs.turnId}/attempts/${refs.attemptId}`;
    try {
      let answer = entry.result;
      if (recover) {
        const value = await stored(`${base}/result`);
        if (!['awaiting_receipt','accepted'].includes(value.status) || !validChatEvent('result', value.result) ||
            value.result.coverage !== 'complete' || value.result.message.id !== answer.message.id) throw new Error('Invalid recovery');
        answer = value.result;
      }
      if (listenerController.signal.aborted || !session.entries.includes(entry) || version !== navigation) return;
      const acknowledged = await stored(`${base}/receipt`, { method: 'POST', body: { messageId: answer.message.id } });
      if (acknowledged.status !== 'accepted' || !validChatEvent('result', acknowledged.answer?.result) ||
          acknowledged.answer.result.message.id !== answer.message.id) throw new Error('Invalid receipt');
      if (listenerController.signal.aborted || !session.entries.includes(entry) || version !== navigation) return;
      entry.receiptStatus = undefined;
      if (!session.history.some((m) => m.id === answer.message.id)) {
        const index = session.entries.indexOf(entry); const user = session.entries[index - 1];
        const at = session.history.findIndex((m) => m.id === user?.id);
        if (at >= 0) session.history.splice(at + 1, 0, { ...answer.message });
      }
    } catch {
      if (!listenerController.signal.aborted && session.entries.includes(entry)) entry.receiptStatus = 'Answer is visible, but receipt was not confirmed. Retry receipt before using it as conversation history.';
    }
    if (activeSession === session && !listenerController.signal.aborted) renderWorkspace();
  }
  /** @param {string} id */
  async function openConversation(id) {
    if (!memoryId(id)) { memoryStatus.textContent = 'Invalid stored conversation identity.'; return; }
    const token = ++navigation; abortActiveRequest('navigation'); loadController?.abort();
    loadController = new AbortController(); memoryBusy = true; syncComposerControls();
    try {
      const value = await stored(`/api/conversations/${id}`, { signal: AbortSignal.any([loadController.signal, listenerController.signal]) });
      if (!validConversation(value) || value.id !== id) throw new Error('Invalid conversation');
      if (token !== navigation || listenerController.signal.aborted) return;
      /** @type {SessionRecord} */ const session = { id: value.id, title: 'Stored conversation', entries: [], history: [], omittedHistoryCount: 0 };
      for (const seed of value.seededMessages) {
        session.history.push({ id: seed.id, role: seed.role, content: seed.content, timestamp: seed.timestamp });
        session.entries.push(seed.role === 'user' ? { id: seed.id, kind: 'user', text: seed.content, timestamp: seed.timestamp } :
          { id: seed.id, kind: 'assistant', text: seed.content, timestamp: seed.timestamp, receiptStatus: 'Imported historical text; original supporting sources are unavailable.' });
      }
      for (const turn of value.turns) {
        session.entries.push({ id: turn.user.id, kind: 'user', text: turn.user.content, timestamp: turn.user.timestamp, timezone: turn.timezone });
        session.history.push({ ...turn.user });
        const attempt = turn.attempts.at(-1);
        submissions.set(turn.user.id, { key: turn.key, attemptKey: attempt && ['running','generated','awaiting_receipt','accepted','partial'].includes(attempt.status) ? attempt.key : generateId('attempt') });
        if (attempt?.answer && ['accepted','partial','awaiting_receipt'].includes(attempt.status)) {
          const answer = attempt.answer.result;
          session.entries.push({ id: attempt.id, kind: 'assistant', text: answer.message.content, timestamp: answer.message.timestamp, result: answer,
            receipt: { conversationId: id, turnId: turn.id, attemptId: attempt.id },
            ...(attempt.status === 'awaiting_receipt' ? { receiptStatus: answer.coverage === 'complete' ? 'Stored answer awaits recovery and receipt confirmation.' : 'Partial answer; excluded from assistant history.' } : {}) });
          if (attempt.status === 'accepted') session.history.push({ ...answer.message });
        } else session.entries.push({ id: attempt?.id ?? turn.id, kind: 'notice', tone: 'warning', title: 'No completed answer',
          subtitle: attempt?.status ?? 'Unsubmitted turn', pill: 'Stored turn', body: 'No accepted answer is stored for this turn. Retry or refresh its server state.',
          retryPrompt: turn.user.content, retryHistory: [], telemetry: {} });
      }
      session.title = buildSessionTitle(value.turns[0]?.user.content ?? value.seededMessages[0]?.content ?? 'Stored conversation');
      const index = sessions.findIndex((s) => s.id === id); if (index >= 0) sessions[index] = session; else sessions.push(session);
      activeSession = session; remoteSessions.add(id); remember(id); memoryStatus.textContent = ''; renderWorkspace();
    } catch (error) {
      if (token !== navigation || listenerController.signal.aborted) return;
      memoryStatus.textContent = error instanceof MemoryApiError && error.status === 404 ? 'This conversation was deleted or is unavailable. Start a new conversation.' : 'Conversation could not be restored. Your current view has been preserved. Refresh conversations to retry.';
      if (error instanceof MemoryApiError && error.status === 404) { remember(null); remoteSessions.delete(id); const index = sessions.findIndex((s) => s.id === id); if (index >= 0 && sessions[index] !== activeSession) sessions.splice(index, 1); }
    } finally { if (token === navigation) { memoryBusy = false; syncComposerControls(); } }
  }
  async function refreshConversations() {
    const token = navigation;
    try {
      for (const offset of [0, 50]) {
        const page = await stored(`/api/conversations?offset=${offset}&limit=50`);
        if (!page || !Array.isArray(page.items) || page.items.length > 50 || !Number.isInteger(page.total) || page.total < 0 || page.total > 100 ||
            !page.items.every((/** @type {any} */ v) => memoryId(v.id))) throw new Error('Invalid list');
        if (token !== navigation || listenerController.signal.aborted) return;
        for (const item of page.items) if (!sessions.some((s) => s.id === item.id)) {
          sessions.push({ id: item.id, title: 'Stored conversation ? open to view', entries: [], history: [], omittedHistoryCount: 0 }); remoteSessions.add(item.id);
        }
        if (offset + page.items.length >= page.total) break;
      }
      memoryStatus.textContent = ''; renderSessionList();
    } catch { if (!listenerController.signal.aborted && token === navigation) memoryStatus.textContent = 'Stored conversations could not be listed. Refresh conversations to retry; the current view is preserved.'; }
  }
  async function restoreConversations() {
    memoryBusy = true; syncComposerControls(); await refreshConversations();
    let saved; try { saved = win?.localStorage.getItem(memoryKey); } catch { /* ID storage is optional. */ }
    if (saved && memoryId(saved) && navigation === 0 && !listenerController.signal.aborted) await openConversation(saved);
    memoryBusy = false; syncComposerControls();
  }

  /**
   * Retries a failed/501/cancelled notice entry in-place without duplicating the user bubble.
   * @param {ThreadNoticeEntry} entry
   */
  async function retryNoticeEntry(entry) {
    if (activeRequest !== null) {
      return;
    }
    const targetSession = activeSession;
    const index = targetSession.entries.findIndex((item) => item.id === entry.id);
    // Detached buttons from a previous render must not retry a successful or
    // superseded response. Resolve association by ID, never by prompt text.
    if (index < 0 || targetSession.entries[index] !== entry) return;
    const userEntry = targetSession.entries[index - 1];
    if (userEntry?.kind !== 'user') return;
    const userIndex = targetSession.history.findIndex((item) => item.id === userEntry.id && item.role === 'user');
    if (userIndex < 0) return;
    const historySnapshot = targetSession.history.slice(0, userIndex);
    if (index >= 0) {
      targetSession.entries.splice(index, 1, {
        id: entry.id,
        kind: 'loading',
        messageText: entry.retryPrompt,
      });
    }
    isUserNearBottom = true;
    renderWorkspace();
    scrollToBottom({ force: true });
    await executeChatSubmission(targetSession, entry.id, entry.retryPrompt, historySnapshot);
  }

  /** @param {'user' | 'navigation'} [reason] */
  function abortActiveRequest(reason = 'user') {
    if (activeRequest) {
      activeRequest.abortReason = reason;
      activeRequest.controller.abort();
      activeRequest = null;
      syncComposerControls();
    }
  }

  async function handleFormSubmit() {
    if (!chatInput || activeRequest !== null || memoryBusy) {
      return;
    }
    const trimmed = chatInput.value.trim();
    if (!trimmed) {
      announce('Enter a message before sending.');
      return;
    }
    if (chatInput.value.length > MAX_MESSAGE_CHARS) {
      const errMsg = `Message exceeds ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} character limit.`;
      showComposerError(errMsg);
      announce(errMsg);
      return;
    }

    const timezone = getLocalTimeZone();
    const baseEnvelopeCheck = buildBoundedChatBody(
      {
        conversationId: activeSession.id,
        message: trimmed,
        timezone,
        history: [],
      },
      { maxHistoryItems, maxBodyBytes },
    );
    if (baseEnvelopeCheck.exceedsLimit) {
      const errMsg = `Request payload is too large (${baseEnvelopeCheck.serializedBytes.toLocaleString('en-US')} UTF-8 bytes including metadata; limit is ${baseEnvelopeCheck.maxBodyBytes.toLocaleString('en-US')} bytes). Shorten your message and try again.`;
      showComposerError(errMsg);
      announce(errMsg);
      chatInput.focus({ preventScroll: true });
      return;
    }

    showComposerError('');
    const timestamp = now().toISOString();
    const historySnapshot = activeSession.history.slice();
    const userMessageId = generateId('msg');

    if (activeSession.entries.length === 0) {
      activeSession.title = buildSessionTitle(trimmed);
    }

    activeSession.entries.push({
      id: userMessageId,
      kind: 'user',
      text: trimmed,
      timestamp,
      timezone,
    });

    activeSession.history.push({
      id: userMessageId,
      role: 'user',
      content: trimmed,
      timestamp,
    });

    const loadingId = generateId('turn');
    activeSession.entries.push({
      id: loadingId,
      kind: 'loading',
      messageText: trimmed,
    });

    persistActiveSessionInList();
    chatInput.value = '';
    syncTextareaHeight();
    isUserNearBottom = true;
    renderWorkspace();
    scrollToBottom({ force: true });

    await executeChatSubmission(activeSession, loadingId, trimmed, historySnapshot);
  }

  function startNewConversation() {
    abortActiveRequest('navigation');
    navigation++; loadController?.abort(); memoryBusy = false; remember(null);
    activeSession = makeBlankSession();
    showComposerError('');
    if (chatInput) {
      chatInput.value = '';
      syncTextareaHeight();
    }
    closeMobileDrawer({ restoreFocus: false, focusTarget: chatInput });
    isUserNearBottom = true;
    renderWorkspace();
    scrollToBottom({ force: true });
    chatInput?.focus({ preventScroll: true });
    announce('Started a new conversation.');
  }

  async function refreshHealth() {
    if (connectionDot) {
      connectionDot.className = 'status-dot is-checking';
    }
    if (connectionText) {
      connectionText.textContent = 'Checking server health…';
    }

    const health = await checkHealth({ fetchImpl });
    if (health.ok) {
      if (connectionDot) {
        connectionDot.className = 'status-dot is-online';
      }
      if (connectionText) {
        const versionSuffix = health.version ? ` v${health.version}` : '';
        connectionText.textContent = `Connected · API${versionSuffix}`;
      }
      if (apiInfoMeta) {
        apiInfoMeta.replaceChildren(
          el(doc, 'span', '', `service=${health.service ?? 'recall-agent'}`),
          el(doc, 'span', '', `version=${health.version ?? 'unknown'}`),
          el(doc, 'span', '', `checked=${health.timestamp ?? now().toISOString()}`),
        );
      }
    } else {
      if (connectionDot) {
        connectionDot.className = 'status-dot is-offline';
      }
      if (connectionText) {
        connectionText.textContent = 'Server unreachable';
      }
      if (apiInfoMeta) {
        apiInfoMeta.replaceChildren(
          el(doc, 'span', '', health.errorMessage || 'GET /health failed'),
        );
      }
    }
    return health;
  }

  const listenerSignal = listenerController.signal;

  // Event listeners
  composerForm.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void handleFormSubmit();
    },
    { signal: listenerSignal },
  );

  // Focus chatInput when clicking composer card background/padding/non-interactive areas
  composerForm.addEventListener(
    'click',
    (event) => {
      const target = /** @type {HTMLElement | null} */ (event.target);
      if (!target || target === chatInput || chatInput.disabled) {
        return;
      }
      const interactive = target.closest(
        'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (interactive && interactive !== composerForm) {
        return;
      }
      chatInput.focus({ preventScroll: true });
      const len = chatInput.value.length;
      if (typeof chatInput.setSelectionRange === 'function') {
        chatInput.setSelectionRange(len, len);
      }
    },
    { signal: listenerSignal },
  );

  chatInput.addEventListener(
    'input',
    () => {
      showComposerError('');
      syncTextareaHeight();
      syncComposerControls();
    },
    { signal: listenerSignal },
  );

  chatInput.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (typeof composerForm.requestSubmit === 'function') {
          composerForm.requestSubmit();
        } else {
          void handleFormSubmit();
        }
      }
    },
    { signal: listenerSignal },
  );

  const starterCards = doc.querySelectorAll('.starter-card[data-prompt]');
  for (const card of starterCards) {
    card.addEventListener(
      'click',
      () => {
        const prompt = card.getAttribute('data-prompt') ?? '';
        chatInput.value = prompt;
        showComposerError('');
        syncTextareaHeight();
        syncComposerControls();
        chatInput.focus({ preventScroll: true });
        announce('Populated suggested prompt in message input.');
      },
      { signal: listenerSignal },
    );
  }

  newChatBtn?.addEventListener('click', startNewConversation, { signal: listenerSignal });
  mobileNewChatBtn?.addEventListener('click', startNewConversation, { signal: listenerSignal });
  sidebarToggleBtn?.addEventListener('click', toggleSidebar, { signal: listenerSignal });
  sidebarCloseBtn?.addEventListener(
    'click',
    () => closeMobileDrawer({ restoreFocus: true }),
    { signal: listenerSignal },
  );
  sidebarBackdrop?.addEventListener(
    'click',
    () => closeMobileDrawer({ restoreFocus: true }),
    { signal: listenerSignal },
  );

  aboutStatusBtn?.addEventListener(
    'click',
    () => {
      if (!apiInfoPanel || !aboutStatusBtn) {
        return;
      }
      const willOpen = apiInfoPanel.hidden;
      apiInfoPanel.hidden = !willOpen;
      aboutStatusBtn.setAttribute('aria-expanded', String(willOpen));
      closeMobileDrawer({
        restoreFocus: false,
        focusTarget: willOpen ? (closeApiInfoBtn ?? chatInput) : chatInput,
      });
      if (willOpen) {
        closeApiInfoBtn?.focus();
        void refreshHealth();
      } else {
        chatInput?.focus({ preventScroll: true });
      }
    },
    { signal: listenerSignal },
  );

  closeApiInfoBtn?.addEventListener(
    'click',
    () => {
      if (!apiInfoPanel || !aboutStatusBtn) {
        return;
      }
      apiInfoPanel.hidden = true;
      aboutStatusBtn.setAttribute('aria-expanded', 'false');
      if (isSidebarVisible()) {
        aboutStatusBtn.focus();
      } else {
        chatInput?.focus({ preventScroll: true });
      }
    },
    { signal: listenerSignal },
  );

  doc.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && isCompactViewport() && appShell.classList.contains('drawer-open')) {
        event.preventDefault();
        closeMobileDrawer({ restoreFocus: true });
      }
    },
    { signal: listenerSignal },
  );

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleViewportChange, { signal: listenerSignal });
    if (typeof window.matchMedia === 'function') {
      const compactMql = window.matchMedia('(max-width: 960px)');
      compactMql.addEventListener?.('change', handleViewportChange, { signal: listenerSignal });
    }
  }

  /** @param {Event} event */
  const handleScroll = (event) => {
    const target = event.target;
    const container = getScrollContainer();
    const isRoot = container === doc.documentElement || container === doc.body || container === doc.scrollingElement;
    if (isRoot) {
      if (target === doc || target === win || target === doc.documentElement || target === doc.body) {
        isUserNearBottom = isNearBottom();
      }
    } else if (target === container) {
      isUserNearBottom = isNearBottom();
    }
  };

  doc.addEventListener('scroll', handleScroll, { passive: true, capture: true, signal: listenerSignal });
  if (win) {
    win.addEventListener('scroll', handleScroll, { passive: true, signal: listenerSignal });
  }

  // Initial state render + accessibility sync + health probe
  appShell.dataset.initialized = 'true';
  syncSidebarAccessibility();
  syncTextareaHeight();
  renderWorkspace();
  composerForm?.before(memoryStatus);
  const initialRestoration = persistence ? restoreConversations() : Promise.resolve();
  const initialHealthPromise = Promise.all([refreshHealth(), initialRestoration]).then(([health]) => health);
  win?.addEventListener('storage', (event) => { if (event.key === memoryKey && persistence) memoryStatus.textContent = 'Another tab changed the active conversation. Refresh conversations to view server state.'; }, { signal: listenerSignal });

  return {
    refreshHealth,
    refreshConversations, openConversation, waitForRestoration: () => initialRestoration,
    startNewConversation,
    getActiveSession: () => activeSession,
    getSessions: () => sessions,
    waitForInitialHealth: () => initialHealthPromise,
    isScrolledToBottom: () => isUserNearBottom,
    scrollToBottom,
    destroy: () => {
      abortActiveRequest('navigation');
      navigation++; loadController?.abort(); memoryStatus.remove(); listenerController.abort();
    },
  };
}

function autoMountIfBrowserDocument() {
  if (typeof document === 'undefined') {
    return;
  }
  if (/** @type {any} */ (globalThis).__RECALL_TEST_ENV__) {
    return;
  }
  const mount = () => {
    const shell = document.getElementById('app-shell');
    if (shell && shell.dataset.initialized !== 'true') {
      createChatApp();
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

autoMountIfBrowserDocument();
