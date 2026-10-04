import type { WebSocket } from 'ws';
import type * as P from '@chh/shared/sync';

/** Live WebSocket connections per user, for "vault changed" and "teams changed" notifications. */
export class Hub {
  private readonly byUser = new Map<string, Set<WebSocket>>();

  add(userId: string, ws: WebSocket) {
    let set = this.byUser.get(userId);
    if (!set) this.byUser.set(userId, (set = new Set()));
    set.add(ws);
    ws.on('close', () => set!.delete(ws));
  }

  notify(userIds: string | Iterable<string>, msg: P.WsServerMessage) {
    const data = JSON.stringify(msg);
    for (const userId of typeof userIds === 'string' ? [userIds] : userIds) {
      for (const ws of this.byUser.get(userId) ?? []) if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  closeUser(userId: string) {
    for (const ws of this.byUser.get(userId) ?? []) ws.close(4001, 'signed out');
  }
}
