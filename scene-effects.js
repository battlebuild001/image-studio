/** Bounded, deterministic image overlays. No clocks, downloads or random frames. */
const TAU = Math.PI * 2;
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const modulo = (value, range) => ((value % range) + range) % range;
function hash(value) {
  let seed = 2166136261;
  for (const char of String(value || 'scene')) {seed ^= char.codePointAt(0);seed = Math.imul(seed, 16777619);}
  return seed >>> 0;
}
function unit(seed, index) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ value >>> 16, 0x85ebca6b);
  value = Math.imul(value ^ value >>> 13, 0xc2b2ae35);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}

/** Render on the image layer, before caption/branding and before crossfade. */
export function drawSceneEffect(ctx, scene, localTime, width, height) {
  const intensity = clamp(scene.effectIntensity ?? .25);
  if (!intensity || !['dust', 'fog', 'light'].includes(scene.effect) || !(width > 0 && height > 0)) return;
  const time = Math.max(0, Number.isFinite(localTime) ? localTime : 0), seed = hash(scene.id);
  const scale = Math.min(width, height) / 1080;
  ctx.save();ctx.beginPath();ctx.rect(0, 0, width, height);ctx.clip();
  // Keep the caller's opacity so transitions can compose the whole scene layer.
  const opacity = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1;
  ctx.globalCompositeOperation = 'source-over';
  if (scene.effect === 'dust') {
    ctx.fillStyle = '#f0e5cf';
    // A particle wraps beyond the canvas edge, never visibly popping in-frame.
    for (let index = 0; index < 28; index++) {
      const key = index * 7, phase = unit(seed, key) * TAU;
      const x = (modulo(unit(seed, key + 1) * 1.16 + time * (.0014 + unit(seed, key + 2) * .0018), 1.16) - .08 + Math.sin(time * .075 + phase) * .012) * width;
      const y = (modulo(unit(seed, key + 3) * 1.16 - time * (.002 + unit(seed, key + 4) * .002), 1.16) - .08) * height;
      const radius = Math.max(.35, (.65 + unit(seed, key + 5) * 1.8) * scale);
      ctx.globalAlpha = opacity * intensity * (.12 + unit(seed, key + 6) * .18) * (.9 + .1 * Math.sin(time * .12 + phase));
      ctx.beginPath();ctx.arc(x, y, radius, 0, TAU);ctx.fill();
    }
  } else if (scene.effect === 'fog') {
    for (let index = 0; index < 3; index++) {
      const phase = unit(seed, index + 50) * TAU;
      const x = width * (.15 + index * .36 + Math.sin(time * .065 + phase) * .075);
      const y = height * (.62 + Math.cos(time * .045 + phase) * .16);
      const radius = Math.max(width * .52, height * .65);
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(194,211,211,${.095 * intensity})`);
      gradient.addColorStop(.5, `rgba(181,201,204,${.045 * intensity})`);
      gradient.addColorStop(1, 'rgba(181,201,204,0)');
      ctx.globalAlpha = opacity;ctx.fillStyle = gradient;ctx.fillRect(0, 0, width, height);
    }
  } else {
    ctx.globalCompositeOperation = 'screen';
    for (let index = 0; index < 2; index++) {
      const phase = unit(seed, index + 80) * TAU;
      const x = width * (index ? .86 : .08) + Math.sin(time * .055 + phase) * width * .065;
      const y = height * (index ? .76 : .15) + Math.cos(time * .045 + phase) * height * .07;
      const radius = Math.max(width * (index ? .45 : .6), height * .7);
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(255,221,167,${(index ? .11 : .16) * intensity})`);
      gradient.addColorStop(.4, `rgba(255,211,149,${.055 * intensity})`);
      gradient.addColorStop(1, 'rgba(255,211,149,0)');
      ctx.globalAlpha = opacity;ctx.fillStyle = gradient;ctx.fillRect(0, 0, width, height);
    }
  }
  ctx.restore();
}
