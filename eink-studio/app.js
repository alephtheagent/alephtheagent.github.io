import { WIDTH, HEIGHT, unpackBits } from './image.js';
import { FONTS } from './fonts.js';
import { createDocument, textLayer, imageLayer, renderDocument, History } from './editor.js';
import { BleTransport } from './ble.js';
const $ = id => document.getElementById(id);
const history = new History(createDocument());
let doc = history.current, frame, connected = false, sending = false;
const selected = () => doc.layers.find(l => l.id === doc.selected);
const clone = () => ({ ...doc, layers: doc.layers.map(l => ({ ...l, crop: l.crop ? { ...l.crop } : null })) });
function commit(next, sync = true) { history.commit(next); doc = history.current; render(sync); }
function change(values, sync = false) { if (!selected()) return; const next = clone(); Object.assign(next.layers.find(l => l.id === next.selected), values); commit(next, sync); }
const numeric = new Set(['x','y','width','height','rotation','scale','zoom','tileSize','brightness','contrast','threshold','offsetX','offsetY']);
const fields = ['x','y','width','height','rotation','visible','text','scale','align','color','background','mode','zoom','tileSize','brightness','contrast','threshold','dither','invert','offsetX','offsetY'];
function paint(canvas, pixels) {
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
  const image = ctx.createImageData(WIDTH, HEIGHT);
  for (let i = 0; i < pixels.length; i++) { image.data[i*4] = image.data[i*4+1] = image.data[i*4+2] = pixels[i]; image.data[i*4+3] = 255; }
  ctx.putImageData(image, 0, 0);
}
const warningLabels = [
  ['text block too narrow for a glyph', 'Блок уже одного символа — увеличьте ширину.'],
  ['text height overflow', 'Текст не помещается по высоте — увеличьте блок или уменьшите масштаб.'],
  ['missing glyphs:', 'Нет глифов (показаны рамки):'],
  ['layer clipped by canvas', 'Слой выходит за холст — часть кадра не попадёт на экран.'],
  ['empty image crop', 'Пустая обрезка — проверьте границы исходника.'],
  ['unknown font', 'Неизвестный шрифт']
];
function render(sync = true) {
  const result = renderDocument(doc); frame = result.frame;
  const pixels = unpackBits(frame); paint($('preview'), pixels); paint($('native'), pixels);
  $('warnings').replaceChildren(...result.warnings.map(w => { const p = document.createElement('p'); p.textContent = warningLabels.reduce((text, [from, to]) => text.replace(from, to), w); return p; }));
  $('undo').disabled = !history.canUndo; $('redo').disabled = !history.canRedo;
  if (sync) syncUI();
}
function syncUI() {
  const layer = selected();
  $('layers').replaceChildren(...[...doc.layers].reverse().map(l => {
    const row = document.createElement('div'); row.className = 'layer-row';
    const visible = document.createElement('input'); visible.type = 'checkbox'; visible.checked = l.visible !== false; visible.setAttribute('aria-label', `Видимость: ${l.name}`);
    visible.addEventListener('change', () => { const next = clone(); next.layers.find(a => a.id === l.id).visible = visible.checked; commit(next); });
    const button = document.createElement('button'); button.textContent = `${l.type === 'text' ? 'Т' : '▧'} ${l.name}`; button.setAttribute('aria-pressed', String(doc.selected === l.id));
    button.addEventListener('click', () => { doc = { ...doc, selected: l.id }; syncUI(); }); row.append(visible, button); return row;
  }));
  $('properties').hidden = !layer; $('empty').hidden = !!layer;
  for (const id of ['raise','lower','duplicate','delete']) $(id).disabled = !layer;
  if (!layer) return;
  $('text-properties').hidden = layer.type !== 'text'; $('image-properties').hidden = layer.type !== 'image';
  $('layer-name').value = layer.name;
  for (const id of fields) if (id in layer) { if ($(id).type === 'checkbox') $(id).checked = layer[id]; else $(id).value = layer[id]; }
  for (const id of ['brightness','contrast','threshold']) $(`${id}-value`).textContent = layer[id] ?? '';
  if (layer.type === 'text') {
    const font = FONTS.find(f => f.id === layer.fontId); $('font-toggle').textContent = `${font.name} · ${font.width}×${font.height} px ▾`;
    $('font-metrics').textContent = `Фиксированная ячейка ${font.width}×${font.height}; сейчас ${font.width*layer.scale}×${font.height*layer.scale} px. Только целочисленное увеличение.`;
    for (const b of $('font-list').querySelectorAll('[role=option]')) b.setAttribute('aria-selected', String(b.dataset.font === layer.fontId));
  } else {
    const crop = layer.crop || { x:0,y:0,width:layer.source.width,height:layer.source.height };
    for (const [id,key] of [['cropX','x'],['cropY','y'],['cropWidth','width'],['cropHeight','height']]) $(id).value = crop[key];
  }
}
for (const id of fields) $(id).addEventListener('input', () => {
  let value = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  if (numeric.has(id)) { if (value === '' || !Number.isFinite(Number(value))) return; value = Number(value); if (['width','height','scale','zoom','tileSize'].includes(id) && value <= 0) return; }
  change({ [id]: value });
  if ($(`${id}-value`)) $(`${id}-value`).textContent = value;
  if (id === 'scale' || id === 'visible') syncUI();
});
$('layer-name').addEventListener('change', () => change({ name: $('layer-name').value }, true));
for (const id of ['cropX','cropY','cropWidth','cropHeight']) $(id).addEventListener('input', () => {
  const values = ['cropX','cropY','cropWidth','cropHeight'].map(key => Number($(key).value));
  if (values.every(Number.isFinite) && values[0]>=0 && values[1]>=0 && values[2]>0 && values[3]>0) change({ crop: { x:values[0],y:values[1],width:values[2],height:values[3] } });
});
$('uncrop').onclick = () => change({crop:null},true);
function add(layer) { const next = clone(); next.layers.push(layer); next.selected = layer.id; commit(next); }
$('add-text').onclick = () => { add(textLayer()); $('text').focus(); };
$('new').onclick = () => commit(createDocument());
$('undo').onclick = () => { doc = history.undo(); render(); };
$('redo').onclick = () => { doc = history.redo(); render(); };
$('delete').onclick = () => { const next = clone(); next.layers = next.layers.filter(l => l.id !== next.selected); next.selected = next.layers.at(-1)?.id ?? null; commit(next); };
$('duplicate').onclick = () => { const layer = selected(); if (!layer) return; const copy = {...layer, id: (layer.type === 'text' ? textLayer() : imageLayer(layer.source,layer.name)).id, name: `${layer.name} — копия`, x:layer.x+2,y:layer.y+2}; add(copy); };
for (const [id,delta] of [['raise',1],['lower',-1]]) $(id).onclick = () => { const next = clone(), i = next.layers.findIndex(l => l.id === next.selected), j = i+delta; if (i<0 || j<0 || j>=next.layers.length) return; [next.layers[i],next.layers[j]] = [next.layers[j],next.layers[i]]; commit(next); };
$('rotate').onclick = () => change({rotation:(selected().rotation+90)%360},true);
$('reset').onclick = () => change({x:0,y:0,width:WIDTH,height:HEIGHT,rotation:0,...(selected().type==='image'?{zoom:1}: {})},true);
async function loadImage(url,name) {
  const image = new Image(); image.src = url; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(image,0,0);
  add(imageLayer(ctx.getImageData(0,0,canvas.width,canvas.height),name));
}
$('open').onclick = () => $('file').click();
$('file').onchange = async () => { const file = $('file').files[0]; if (!file) return; const url = URL.createObjectURL(file); try { await loadImage(url,file.name); } catch(e) { $('status').textContent = `Ошибка изображения: ${e.message}`; } finally { URL.revokeObjectURL(url); $('file').value = ''; } };
$('reference').onclick = async () => { try { await loadImage('data:image/png;base64,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','Эталон'); } catch(e) { $('status').textContent = e.message; } };
function fontPreview(font) {
  const label = `${font.name} Аа Бб 123`, canvas = document.createElement('canvas'); canvas.width = Math.min(300,label.length*font.width); canvas.height = font.height;
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.fillStyle = 'white'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.fillStyle = 'black';
  Array.from(label).forEach((ch,i) => { const glyph = font.glyphs[ch]; if (glyph) glyph.forEach((row,y) => Array.from(row).forEach((bit,x) => { if (bit === '1') ctx.fillRect(i*font.width+x,y,1,1); })); });
  canvas.setAttribute('aria-hidden','true'); return canvas;
}
let lastHeight;
for (const font of [...FONTS].sort((a,b) => a.height-b.height)) {
  if (font.height !== lastHeight) { const heading = document.createElement('h3'); heading.textContent = `${font.height} px · родной растр`; $('font-list').append(heading); lastHeight = font.height; }
  const button = document.createElement('button'); button.setAttribute('role','option'); button.dataset.font = font.id;
  const description = document.createElement('small'); description.textContent = `${font.name} · ${font.width}×${font.height} px`;
  button.append(fontPreview(font),description); button.onclick = () => { change({fontId:font.id},true); closeFonts(); }; $('font-list').append(button);
}
function closeFonts() { $('font-list').hidden = true; $('font-toggle').setAttribute('aria-expanded','false'); $('font-toggle').focus(); }
$('font-toggle').onclick = () => { const open = $('font-list').hidden; $('font-list').hidden = !open; $('font-toggle').setAttribute('aria-expanded',String(open)); if (open) ($('font-list').querySelector('[aria-selected=true]') || $('font-list').querySelector('button')).focus(); };
$('font-toggle').onkeydown = e => { if (e.key === 'ArrowDown' && $('font-list').hidden) { e.preventDefault(); $('font-toggle').click(); } };
$('font-list').onkeydown = e => { const buttons = [...$('font-list').querySelectorAll('button')], i = buttons.indexOf(document.activeElement); if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) { e.preventDefault(); const j = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length-1 : (i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length; buttons[j].focus(); } if (e.key==='Escape') {e.preventDefault();closeFonts();} };
document.addEventListener('pointerdown', e => { if (!$('font-list').hidden && !e.target.closest('.font-picker')) { $('font-list').hidden = true; $('font-toggle').setAttribute('aria-expanded','false'); } });
function resize(factor) { const l = selected(); if (l) change({width:Math.max(1,Math.round(l.width*factor)),height:Math.max(1,Math.round(l.height*factor))},true); }
$('preview').onkeydown = e => { const l = selected(); if (!l) return; const step=e.shiftKey?10:1, moves={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}; if (moves[e.key]) {e.preventDefault();change({x:l.x+moves[e.key][0],y:l.y+moves[e.key][1]},true);} else if (['+','=','-'].includes(e.key)) {e.preventDefault();resize(e.key==='-'?1/1.1:1.1);} };
document.addEventListener('keydown', e => { if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z' && !['INPUT','TEXTAREA'].includes(e.target.tagName)) { e.preventDefault(); $(e.shiftKey?'redo':'undo').click(); } });
const pointers = new Map(); let dragStart = null;
const distance = () => { const p=[...pointers.values()]; return p.length>1?Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y):0; };
$('preview').addEventListener('pointerdown', e => { if (e.button!==0 || !selected()) return; if (!pointers.size) dragStart=clone(); $('preview').setPointerCapture(e.pointerId); pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); e.preventDefault(); });
$('preview').addEventListener('pointermove', e => { const old = pointers.get(e.pointerId); if (!old) return; const before = distance(); pointers.set(e.pointerId,{x:e.clientX,y:e.clientY}); const next=clone(), l=next.layers.find(l=>l.id===next.selected); if (!l) return;
  if (pointers.size>1) {const after=distance();if(before>0&&after>0){l.width=Math.max(1,Math.round(l.width*after/before));l.height=Math.max(1,Math.round(l.height*after/before));}}
  else {const r=$('preview').getBoundingClientRect();l.x+= (e.clientX-old.x)*WIDTH/r.width;l.y+=(e.clientY-old.y)*HEIGHT/r.height;}
  doc=next;render();
});
for (const type of ['pointerup','pointercancel','lostpointercapture']) $('preview').addEventListener(type,e=> {pointers.delete(e.pointerId);if(!pointers.size&&dragStart){const next=clone();next.layers=next.layers.map(l=>({...l,x:Math.round(l.x),y:Math.round(l.y)}));dragStart=null;commit(next);}});
$('preview').addEventListener('wheel',e=>{if(!selected())return;e.preventDefault();resize(e.deltaY<0?1.1:1/1.1);},{passive:false});
function download(blob,name) { const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
$('png').onclick = () => $('native').toBlob(blob=>{if(blob)download(blob,'eink-122x250.png');},'image/png');
$('frame').onclick = () => download(new Blob([frame],{type:'application/octet-stream'}),'eink-122x250.bin');
function buttons(){ $('connect').disabled=connected||sending||!navigator.bluetooth;$('send').disabled=!connected||sending;$('disconnect').disabled=!connected||sending; }
const transport=new BleTransport({onProgress:(n,total)=>{$('progress').max=total;$('progress').value=n;$('status').textContent=`Отправлено: ${n} / ${total} байт.`;},onStatus:s=>{if(s.disconnected){connected=false;$('status').textContent='Соединение прервано. Подключитесь заново.';buttons();}else if(s.state===2||s.state===3)$('status').textContent='Кадр принят; обновление дисплея…';}});
$('connect').onclick=async()=>{sending=true;buttons();try{await transport.connect();connected=true;$('status').textContent='Подключено.';}catch(e){transport.disconnect();$('status').textContent=`Ошибка подключения: ${e.message}`;}finally{sending=false;buttons();}};
$('disconnect').onclick=()=>{transport.disconnect();connected=false;$('status').textContent='Отключено.';buttons();};
$('send').onclick=async()=>{const snapshot=frame.slice();sending=true;$('progress').value=0;buttons();try{await transport.send(snapshot);$('status').textContent='Дисплей обновлён.';}catch(e){$('status').textContent=`Ошибка отправки: ${e.message}`;if(!transport.command)connected=false;}finally{sending=false;buttons();}};
$('status').textContent=navigator.bluetooth?'Не подключено.':'Web Bluetooth недоступен. Редактор и экспорт работают; для отправки нужен совместимый браузер.';
buttons();render();
