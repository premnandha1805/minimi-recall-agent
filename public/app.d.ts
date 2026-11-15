import type { ChatHistoryItem, HealthStatusResult } from './api.js';

export const MAX_MESSAGE_CHARS: number;

export interface ChatAppInstance {
  refreshHealth: () => Promise<HealthStatusResult>;
  startNewConversation: () => void;
  getActiveSession: () => {
    id: string;
    title: string;
    entries: Array<{ id: string; kind: string }>;
    history: ChatHistoryItem[];
    omittedHistoryCount: number;
  };
  getSessions: () => Array<{ id: string; title: string }>;
  waitForInitialHealth: () => Promise<unknown>;
  destroy: () => void;
  isScrolledToBottom?: () => boolean;
  scrollToBottom?: (options?: { force?: boolean }) => void;
}

export function createChatApp(options?: {
  root?: Document;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  generateId?: (prefix: string) => string;
  maxHistoryItems?: number;
  maxBodyBytes?: number;
}): ChatAppInstance;
