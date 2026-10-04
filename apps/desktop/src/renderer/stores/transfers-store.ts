import { create } from 'zustand';
import type { Transfer } from '@chh/shared';

interface TransfersState {
  transfers: Transfer[];
  upsert(t: Transfer): void;
  clearFinished(endpoints: string[]): void;
}

const finished = (t: Transfer) => t.state === 'done' || t.state === 'cancelled' || t.state === 'error';

export const useTransfers = create<TransfersState>((set, get) => ({
  transfers: [],
  upsert(t) {
    const list = get().transfers;
    const i = list.findIndex((x) => x.id === t.id);
    set({ transfers: i < 0 ? [...list, t] : list.map((x, j) => (j === i ? t : x)) });
  },
  clearFinished(endpoints) {
    set({ transfers: get().transfers.filter((t) => !(finished(t) && (endpoints.includes(t.src.endpoint) || endpoints.includes(t.dst.endpoint)))) });
  },
}));

window.chh.on('transfer.update', (t) => useTransfers.getState().upsert(t));
