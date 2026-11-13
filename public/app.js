// @ts-check
import {
  DEFAULT_MAX_BODY_BYTES,
  MAX_HISTORY_ITEMS,
  MAX_MESSAGE_CHARS,
  buildBoundedChatBody,
  checkHealth,
  getLocalTimeZone,
  sendChatRequest,
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
 * }} [options]
 */
export function createChatApp(options = {}) {
  const doc = options.root ?? document;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? defaultIdGenerator;
  const maxHistoryItems = options.maxHistoryItems ?? MAX_HISTORY_ITEMS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const listenerController = new AbortController();

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
  /** @type {HTMLElement | null} */
  let drawerReturnFocusEl = null;

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
    const compactNow = isCompactViewport();
    if (compactNow === lastCompactViewport) {
      syncSidebarAccessibility();
      return;
    }
    lastCompactViewport = compactNow;
    appShell?.classList.remove('drawer-open');
    drawerReturnFocusEl = null;
    syncSidebarAccessibility({ focusTarget: compactNow ? sidebarToggleBtn : chatInput });
  }

  function syncTextareaHeight() {
    if (!chatInput) {
      return;
    }
    chatInput.style.height = 'auto';
    const nextHeight = Math.min(Math.max(chatInput.scrollHeight, 44), 180);
    chatInput.style.height = `${nextHeight}px`;
  }

  function syncComposerControls() {
    if (!chatInput || !sendButton || !composerForm) {
      return;
    }
    const raw = chatInput.value;
    const trimmed = raw.trim();
    const isOverLimit = raw.length > MAX_MESSAGE_CHARS;
    const isLocked = activeRequest !== null;

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

    if (sessions.length === 0) {
      sessionListEl.appendChild(
        el(
          doc,
          'p',
          'session-empty-note',
          'Conversations stay in this browser tab until you refresh or close it.',
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
        if (item.id === activeSession.id) {
          closeMobileDrawer({ restoreFocus: false, focusTarget: chatInput });
          chatInput?.focus();
          return;
        }
        abortActiveRequest('navigation');
        activeSession = item;
        showComposerError('');
        closeMobileDrawer({ restoreFocus: false, focusTarget: chatInput });
        renderWorkspace();
        chatInput?.focus();
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
    retained.appendChild(el(doc, 'span', '', 'Session only'));
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

    titleRow.appendChild(el(doc, 'span', 'loading-label', 'Sending request to Recall Agent…'));
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
      el(doc, 'span', '', 'Your message is retained in this browser session (not saved to disk yet).'),
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
    answerCard.appendChild(el(doc, 'div', 'assistant-answer-card', entry.text));
    article.appendChild(answerCard);

    return article;
  }

  function renderWorkspace() {
    if (!welcomeView || !threadView || !messageListEl) {
      return;
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
        omittedHistoryNoteEl.textContent = `${count} earlier session ${count === 1 ? 'message was' : 'messages were'} omitted from the API request payload to stay within backend history (100) and size (256 KB) limits; full messages remain visible in this tab only.`;
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

    renderSessionList();
    syncComposerControls();

    const lastChild = messageListEl.lastElementChild;
    if (lastChild && typeof lastChild.scrollIntoView === 'function') {
      lastChild.scrollIntoView({ block: 'end' });
    }
  }

  /**
   * Executes POST /api/chat and transforms a loading entry into the final response entry.
   * @param {SessionRecord} targetSession
   * @param {string} loadingEntryId
   * @param {string} promptText
   * @param {import('./api.js').ChatHistoryItem[]} historySnapshot
   */
  async function executeChatSubmission(targetSession, loadingEntryId, promptText, historySnapshot) {
    const requestToken = ++nextRequestToken;
    /** @type {{ controller: AbortController, sessionId: string, requestToken: number, abortReason: 'user' | 'navigation' | null }} */
    const requestState = {
      controller: new AbortController(),
      sessionId: targetSession.id,
      requestToken,
      abortReason: null,
    };
    activeRequest = requestState;
    const timezone = getLocalTimeZone();

    const boundedPreview = buildBoundedChatBody(
      {
        conversationId: targetSession.id,
        message: promptText,
        timezone,
        history: historySnapshot,
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
        history: historySnapshot,
      },
      {
        signal: requestState.controller.signal,
        fetchImpl,
        maxHistoryItems,
        maxBodyBytes,
      },
    );

    if (activeRequest?.requestToken === requestToken) {
      activeRequest = null;
    }

    if (typeof result.omittedHistoryCount === 'number') {
      targetSession.omittedHistoryCount = result.omittedHistoryCount;
    }

    const isCurrentActiveSession = activeSession.id === targetSession.id;
    const abortedByNavigation = requestState.abortReason === 'navigation';
    const shouldAnnounceAndFocus = isCurrentActiveSession && !abortedByNavigation;

    const index = targetSession.entries.findIndex((item) => item.id === loadingEntryId);
    /** @param {ThreadEntry} replacement */
    const replaceEntry = (replacement) => {
      if (index >= 0) {
        targetSession.entries.splice(index, 1, replacement);
      } else {
        targetSession.entries.push(replacement);
      }
    };

    if (result.kind === 'not_implemented') {
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
      if (shouldAnnounceAndFocus) {
        announce('Server responded with HTTP 501: agent not implemented yet.');
      }
    } else if (result.kind === 'aborted') {
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
      if (shouldAnnounceAndFocus) {
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
      if (shouldAnnounceAndFocus) {
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
      if (shouldAnnounceAndFocus) {
        announce(`Server error HTTP ${status}.`);
      }
    } else {
      // No final 200 JSON or SSE chat response contract is active in this build;
      // never fabricate assistant text or insert unvalidated responses into history.
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
      if (shouldAnnounceAndFocus) {
        announce(`Server returned HTTP ${status} without a supported assistant response.`);
      }
    }

    if (isCurrentActiveSession) {
      renderWorkspace();
      if (shouldAnnounceAndFocus) {
        chatInput?.focus();
      }
    } else {
      syncComposerControls();
    }
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
    if (index >= 0) {
      targetSession.entries.splice(index, 1, {
        id: entry.id,
        kind: 'loading',
        messageText: entry.retryPrompt,
      });
    }
    renderWorkspace();
    await executeChatSubmission(targetSession, entry.id, entry.retryPrompt, entry.retryHistory);
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
    if (!chatInput || activeRequest !== null) {
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
      chatInput.focus();
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
    renderWorkspace();

    await executeChatSubmission(activeSession, loadingId, trimmed, historySnapshot);
  }

  function startNewConversation() {
    abortActiveRequest('navigation');
    activeSession = makeBlankSession();
    showComposerError('');
    if (chatInput) {
      chatInput.value = '';
      syncTextareaHeight();
    }
    closeMobileDrawer({ restoreFocus: false, focusTarget: chatInput });
    renderWorkspace();
    chatInput?.focus();
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
      chatInput.focus();
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
        chatInput.focus();
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
        chatInput?.focus();
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
        chatInput?.focus();
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

  // Initial state render + accessibility sync + health probe
  appShell.dataset.initialized = 'true';
  syncSidebarAccessibility();
  syncTextareaHeight();
  renderWorkspace();
  const initialHealthPromise = refreshHealth();

  return {
    refreshHealth,
    startNewConversation,
    getActiveSession: () => activeSession,
    getSessions: () => sessions,
    waitForInitialHealth: () => initialHealthPromise,
    destroy: () => {
      abortActiveRequest('navigation');
      listenerController.abort();
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
