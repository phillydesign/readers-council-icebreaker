// One hundred selectable stops: fifty on each side, with no exact midpoint.
export function positionFromStep(step) {
  const value = Math.max(0, Math.min(99, Math.round(Number(step))));
  return value < 50 ? value : value + 1;
}

export function stepFromPosition(position) {
  const value = Math.max(0, Math.min(100, Math.round(Number(position))));
  return value < 50 ? value : Math.max(50, value - 1);
}

// Interpolate the supplied Technical.ly blue and green in the same sRGB space
// as the slider's CSS gradient. Each dot gets its color from its actual position.
export function colorForPosition(position) {
  const fraction = Math.max(0, Math.min(100, Number(position))) / 100;
  const blue = [13, 107, 152]; // #0D6B98
  const green = [74, 255, 160]; // #4AFFA0
  const channels = blue.map((value, index) => Math.round(value + (green[index] - value) * fraction));
  return `rgb(${channels.join(', ')})`;
}
