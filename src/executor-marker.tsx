import './executor-marker.css';

interface MarkerProps {
  name: string;
  color?: string | null;
  id?: string;
}

const namedTones: Record<string, string> = { red: '#ff939d', blue: '#8ac4ff', yellow: '#f1c75c' };

function fallbackColor(id?: string) {
  if (!id || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) return '#a1aaa8';
  // Match the server's stable profile colour for older accounts without a configured colour.
  const seed = (parseInt(id.slice(0, 8), 16) ^ parseInt(id.slice(-8), 16)) >>> 0;
  const hue = ((seed % 360) * 137) % 360;
  const step = Math.round((106 * (hue % 60)) / 60);
  const rgb = [
    [226, 120 + step, 120],
    [226 - step, 226, 120],
    [120, 226, 120 + step],
    [120, 226 - step, 226],
    [120 + step, 120, 226],
    [226, 120, 226 - step],
  ][Math.floor(hue / 60)];
  return '#' + rgb.map((component) => component.toString(16).padStart(2, '0')).join('');
}

export function ExecutorMarker({ name, color, id }: MarkerProps) {
  const value = (color || '').toLowerCase();
  const tone = /^#[0-9a-f]{6}$/.test(value)
    ? value
    : Object.hasOwn(namedTones, value)
      ? namedTones[value]
      : fallbackColor(id);
  return (
    <span class="executor-marker" data-mechanic-id={id} style={{ '--executor-color': tone }}>
      {name || 'Механик'}
    </span>
  );
}
