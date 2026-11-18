import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GarageClient, Order } from './shift-model';

type VehicleAction = 'take' | 'handoff';
interface Command {
  orderId: string;
  action: VehicleAction;
  version: number;
  note: string;
  requestId: string;
}
interface ActionFeedback {
  message: string;
  error: boolean;
}
const actionMessages = {
  take: 'Автомобиль взят в работу.',
  handoff: 'Автомобиль передан владельцу на проверку.',
};

export function useVehicleActions(
  client: GarageClient,
  online: boolean,
  refresh: () => Promise<void>,
  openTaken: (id: string) => void,
) {
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState<Command | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function send(command: Command) {
    if (pending.current || !online) return false;
    pending.current = true;
    setSaving(true);
    setFeedback(null);
    let accepted = false;
    try {
      const result = await client.rpc('garage_vehicle_action', {
        p_order_id: command.orderId,
        p_action: command.action,
        p_expected_version: command.version,
        p_request_id: command.requestId,
        p_note: command.note,
      });
      if (result.error) throw result.error;
      accepted = true;
      if (mounted.current) {
        setUncertain(null);
        setFeedback({ message: actionMessages[command.action], error: false });
      }
    } catch (cause) {
      if (mounted.current) {
        const issue = cause as { code?: string; message?: string };
        const ambiguous = !issue?.code || /network|timeout|fetch|connection|lost/i.test(issue?.message || '');
        setUncertain(ambiguous ? command : null);
        let message = 'Не удалось сохранить изменение. Проверьте автомобиль и повторите попытку.';
        if (ambiguous) message = 'Ответ не получен. Проверьте отправку, чтобы узнать результат.';
        else if (/without financial information/i.test(issue?.message || ''))
          message = 'В комментарии допускаются только сведения о работе. Измените текст и повторите передачу.';
        else if (issue?.code === '42501')
          message = 'У вас больше нет доступа к этому действию. Проверьте состояние автомобиля.';
        else if (issue?.code === '40001')
          message = 'Состояние автомобиля изменилось. Проверьте ответственного и список работ.';
        setFeedback({ message, error: true });
      }
    } finally {
      if (mounted.current) await refresh();
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
    if (accepted && mounted.current && command.action === 'take') openTaken(command.orderId);
    return accepted;
  }
  function run(order: Order, action: VehicleAction, version: number, note = '') {
    if (uncertain || !Number.isInteger(version)) return Promise.resolve(false);
    return send({ orderId: order.id, action, version, note: note.trim(), requestId: crypto.randomUUID() });
  }
  return { run, saving, uncertain, feedback, retry: () => uncertain && send(uncertain) };
}
