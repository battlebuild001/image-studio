import {normalizeDiagramCard} from './production-visual-protocol.js';
const FONT = '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
const PALETTE = ['#dfbb84', '#8fc4c9', '#9fbc93', '#bf9ec7', '#d29b85', '#8faadd'];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function wrap(ctx, value, maximum, limit = 3) {
  const lines = [];let line = '';
  for (const character of Array.from(String(value || ''))) {
    if (character === '\n' || (line && ctx.measureText(line + character).width > maximum)) {lines.push(line);line = character === '\n' ? '' : character;} else line += character;
  }
  if (line) lines.push(line);
  if (lines.length <= limit) return lines;
  const bounded = lines.slice(0, limit);let final = bounded.at(-1);
  while (final && ctx.measureText(final + '…').width > maximum) final = final.slice(0, -1);
  bounded[limit - 1] = final + '…';return bounded;
}
function text(ctx, value, x, y, maxWidth, fontSize, {color = '#eef3ed', weight = 500, align = 'left', lines = 2, leading = 1.35} = {}) {
  ctx.font = `${weight} ${fontSize}px ${FONT}`;ctx.textAlign = align;ctx.textBaseline = 'top';ctx.fillStyle = color;
  const rows = wrap(ctx, value, maxWidth, lines);rows.forEach((line, index) => ctx.fillText(line, x, y + index * fontSize * leading));return rows.length * fontSize * leading;
}
function box(ctx, x, y, width, height, fill, stroke) {
  ctx.fillStyle = fill;ctx.fillRect(x, y, width, height);if (stroke) {ctx.strokeStyle = stroke;ctx.lineWidth = 1;ctx.strokeRect(x, y, width, height);}
}
export function productionDiagramLayout(input, width = 1280, height = 720) {
  const card = normalizeDiagramCard(input), scale = Math.min(width, height) / 720;
  const left = width * .07, top = height * (card.type === 'map' ? .29 : .25), bodyWidth = width * .86, bodyHeight = height * (card.type === 'map' ? .56 : .61);
  let nodes = [];
  if (['relations', 'map'].includes(card.type)) {
    const boxWidth = Math.min(bodyWidth * .26, 180 * scale), boxHeight = 62 * scale;
    nodes = card.nodes.map((node, index) => {
      let x, y;
      if (card.type === 'map') {x = left + boxWidth / 2 + node.x * (bodyWidth - boxWidth);y = top + boxHeight / 2 + node.y * (bodyHeight - boxHeight);}
      else if (card.nodes.length <= 6) {const angle = -Math.PI / 2 + index * Math.PI * 2 / card.nodes.length;x = width / 2 + Math.cos(angle) * (bodyWidth - boxWidth) * .44;y = top + bodyHeight / 2 + Math.sin(angle) * (bodyHeight - boxHeight) * .44;}
      else {const cols = width < height ? 3 : 4, rows = Math.ceil(card.nodes.length / cols);x = left + (index % cols + .5) * bodyWidth / cols;y = top + (Math.floor(index / cols) + .5) * bodyHeight / rows;}
      return {...node, x, y, width: boxWidth, height: boxHeight};
    });
  }
  return {card, width, height, scale, left, top, bodyWidth, bodyHeight, nodes};
}
/** Local vector/text graphics: no external image, logo, service or generation call. */
export function drawProductionDiagram(ctx, input, width = ctx.canvas.width, height = ctx.canvas.height) {
  const layout = productionDiagramLayout(input, width, height), {card, scale: s, left, top, bodyWidth, bodyHeight} = layout;
  ctx.save();ctx.setTransform(1, 0, 0, 1, 0, 0);ctx.globalAlpha = 1;ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#102025';ctx.fillRect(0, 0, width, height);
  const shade = ctx.createLinearGradient(0, 0, width, height);shade.addColorStop(0, '#172c33');shade.addColorStop(1, '#0b1419');ctx.fillStyle = shade;ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#dfbb84';ctx.fillRect(left, height * .07, Math.min(90 * s, width * .15), 4 * s);
  let titleSize = 42 * s;
  while (titleSize > 24 * s) {ctx.font = `700 ${titleSize}px ${FONT}`;const rows = wrap(ctx, card.title, bodyWidth, 99).length;if (rows <= 2 && rows * titleSize * 1.35 <= height * .095) break;titleSize -= 2 * s;}
  text(ctx, card.title, left, height * .09, bodyWidth, titleSize, {weight: 700, lines: 2});
  text(ctx, card.subtitle, left, height * .20, bodyWidth, 18 * s, {color: '#b8c8c9', lines: 1});
  if (card.type === 'map') text(ctx, '장소 개념도 · 실제 축척과 지리적 경계가 아닙니다.', left, height * .235, bodyWidth, 12 * s, {color: '#dfbb84', lines: 1});
  if (card.type === 'timeline') {
    const rowHeight = bodyHeight / card.events.length, x = left + bodyWidth * .18;
    ctx.strokeStyle = '#50666a';ctx.lineWidth = 3 * s;ctx.beginPath();ctx.moveTo(x, top + 10 * s);ctx.lineTo(x, top + bodyHeight - 10 * s);ctx.stroke();
    card.events.forEach((event, index) => {
      const y = top + index * rowHeight, size = Math.min(22 * s, Math.max(14 * s, rowHeight * .30));
      ctx.fillStyle = PALETTE[index % PALETTE.length];ctx.beginPath();ctx.arc(x, y + 12 * s, 5 * s, 0, Math.PI * 2);ctx.fill();
      text(ctx, event.date, x - 20 * s, y + 2 * s, bodyWidth * .16 - 12 * s, size * .85, {align: 'right', color: '#dfbb84', lines: 1});
      const textX = x + 22 * s, available = bodyWidth * .80 - 22 * s;
      text(ctx, event.label, textX, y, available, size, {weight: 650, lines: 1});
      text(ctx, event.detail, textX, y + size * 1.45, available, Math.max(10 * s, size * .70), {color: '#aabec3', lines: rowHeight > 60 * s ? 2 : 1});
    });
  } else if (card.type === 'chart') {
    const negative = Math.min(0, ...card.series.map(entry => entry.value)), positive = Math.max(0, ...card.series.map(entry => entry.value)), span = Math.max(positive - negative, 1);
    const plotX = left + bodyWidth * .25, plotWidth = bodyWidth * .58, zeroX = plotX + (-negative / span) * plotWidth, rowHeight = bodyHeight / card.series.length;
    ctx.strokeStyle = '#718487';ctx.lineWidth = 1.5 * s;ctx.beginPath();ctx.moveTo(zeroX, top);ctx.lineTo(zeroX, top + bodyHeight);ctx.stroke();
    card.series.forEach((entry, index) => {
      const y = top + (index + .18) * rowHeight, barHeight = Math.min(34 * s, rowHeight * .55), end = plotX + (entry.value - negative) / span * plotWidth, size = Math.min(20 * s, Math.max(13 * s, rowHeight * .32));
      text(ctx, entry.label, plotX - 14 * s, y, bodyWidth * .23, size, {align: 'right', lines: 2});
      ctx.fillStyle = PALETTE[index % PALETTE.length];ctx.fillRect(Math.min(zeroX, end), y, Math.max(1, Math.abs(end - zeroX)), barHeight);
      text(ctx, `${entry.value.toLocaleString('ko-KR')}${entry.unit ? ' ' + entry.unit : ''}`, left + bodyWidth, y, bodyWidth * .17, size * .83, {align: 'right', color: '#d3dcd6', lines: 2});
    });
  } else {
    const byId = new Map(layout.nodes.map(node => [node.id, node]));
    if (card.type === 'map') {
      ctx.strokeStyle = '#243d44';ctx.lineWidth = 1;
      for (let x = left; x <= left + bodyWidth; x += bodyWidth / 8) {ctx.beginPath();ctx.moveTo(x, top);ctx.lineTo(x, top + bodyHeight);ctx.stroke();}
      for (let y = top; y <= top + bodyHeight; y += bodyHeight / 8) {ctx.beginPath();ctx.moveTo(left, y);ctx.lineTo(left + bodyWidth, y);ctx.stroke();}
    }
    card.edges.forEach((edge, index) => {
      const a = byId.get(edge.from), b = byId.get(edge.to);if (!a || !b) return;
      ctx.strokeStyle = '#6b858a';ctx.lineWidth = 2 * s;ctx.beginPath();ctx.moveTo(a.x, a.y);ctx.lineTo(b.x, b.y);ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x), gap = Math.min(b.width, b.height) * .45;
      const endX = b.x - Math.cos(angle) * gap, endY = b.y - Math.sin(angle) * gap;
      ctx.beginPath();ctx.moveTo(endX, endY);ctx.lineTo(endX - 10 * s * Math.cos(angle - .4), endY - 10 * s * Math.sin(angle - .4));ctx.moveTo(endX, endY);ctx.lineTo(endX - 10 * s * Math.cos(angle + .4), endY - 10 * s * Math.sin(angle + .4));ctx.stroke();
      const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2 + (index % 3 - 1) * 15 * s;
      if (edge.label) {ctx.font = `500 ${13 * s}px ${FONT}`;const labelWidth = Math.min(ctx.measureText(edge.label).width + 14 * s, bodyWidth * .37);box(ctx, x - labelWidth / 2, y - 4 * s, labelWidth, 24 * s, '#102025');text(ctx, edge.label, x, y, labelWidth - 10 * s, 13 * s, {align: 'center', color: '#c3d2cd', lines: 1});}
    });
    layout.nodes.forEach((node, index) => {
      box(ctx, node.x - node.width / 2, node.y - node.height / 2, node.width, node.height, '#1d343b', PALETTE[index % PALETTE.length]);
      const size = card.type === 'map' ? 17 * s : 18 * s;ctx.font = `600 ${size}px ${FONT}`;const count = wrap(ctx, node.label, node.width - 14 * s, 2).length;
      text(ctx, node.label, node.x, node.y - count * size * 1.35 / 2, node.width - 14 * s, size, {align: 'center', weight: 600, lines: 2});
    });
  }
  const footer = card.type === 'map' ? '개념도 · 실제 축척과 지리적 경계를 나타내지 않습니다.' : '제공한 대본·자료를 바탕으로 구성한 정보 화면';
  text(ctx, footer, left, height * .93, bodyWidth, 13 * s, {color: '#8ca6aa', lines: 1});
  if (card.notes.length) text(ctx, card.notes[0], left, height * .89, bodyWidth, 12 * s, {color: '#b8afa0', lines: 1});
  ctx.restore();return layout;
}
