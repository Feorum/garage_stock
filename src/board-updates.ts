import type { Client } from './workspace-types';

// The change payload is a per-recipient revision. Readers refetch actor-authorized records.
export function subscribeBoardUpdates(
  client: Client,
  profileId: string,
  onSignal: () => void,
  connection?: (connected: boolean) => void,
  scope = 'board',
  refreshOnConnect = true,
) {
  let firstConnection = true;
  const channel = client
    .channel?.('workshop-' + scope + '-' + profileId)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'garage_board_updates', filter: 'recipient_id=eq.' + profileId },
      onSignal,
    )
    .subscribe((status) => {
      const ready = status === 'SUBSCRIBED';
      connection?.(ready);
      if (ready) {
        if (refreshOnConnect || !firstConnection) onSignal();
        firstConnection = false;
      }
    });
  return () => {
    if (channel) void client.removeChannel(channel);
  };
}
