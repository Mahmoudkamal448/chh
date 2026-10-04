import { create } from 'zustand';
import type { AuthPrompt, HostKeyPrompt } from '@cy-ssh/shared';

export type Prompt = { type: 'hostkey'; data: HostKeyPrompt } | { type: 'auth'; data: AuthPrompt };

interface PromptsState {
  queue: Prompt[];
  push(p: Prompt): void;
  remove(promptId: string): void;
}

/** Prompts are shown one at a time, oldest first. */
export const usePrompts = create<PromptsState>((set, get) => ({
  queue: [],
  push: (p) => set({ queue: [...get().queue, p] }),
  remove: (promptId) => set({ queue: get().queue.filter((p) => p.data.promptId !== promptId) }),
}));
