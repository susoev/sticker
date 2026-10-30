// Проверка: стрелки переставляют строку, Ctrl+B делает её жирной.
const fs = require('fs');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
module.exports = async ({ sticker, send, app }) => {
  const js = (c) => sticker.webContents.executeJavaScript(c);
  const order = () => js(`[...document.querySelectorAll('.row')].map(r => (r.classList.contains('bold')?'*':'') + (r.querySelector('.text,.edit').textContent || r.querySelector('.edit')?.value)).join(' | ')`);
  const key = (k, code, ctrl=false) => js(`document.querySelector('.edit').dispatchEvent(new KeyboardEvent('keydown',{key:'${k}',code:'${code}',ctrlKey:${ctrl},bubbles:true}))`);
  await wait(2000);
  send('active', true); await wait(400);
  console.log('START ', await order());
  await js(`document.querySelector('.row:nth-child(3) .text').click()`); await wait(200);
  await key('ArrowUp','ArrowUp'); await wait(150);
  console.log('UP    ', await order());
  await key('ArrowUp','ArrowUp'); await wait(150);
  await key('ArrowUp','ArrowUp'); await wait(150);
  console.log('UPx3  ', await order(), ' caret=', await js(`document.activeElement.className + ':' + document.activeElement.selectionStart`));
  await key('ArrowDown','ArrowDown'); await wait(150);
  console.log('DOWN  ', await order());
  await key('и','KeyB',true); await wait(150);
  console.log('BOLD  ', await order());
  await key('Enter','Enter'); await wait(150);
  await key('Escape','Escape'); await wait(150);
  console.log('AFTER ', await order());
  const img = await sticker.webContents.capturePage(); fs.writeFileSync('/tmp/shots/keys.png', img.toPNG());
  await wait(500);
  console.log('SAVED ', JSON.stringify(JSON.parse(fs.readFileSync(process.env.STICKER_DATA + '/notes.json','utf8')).lines.map(l => (l.bold?'*':'')+l.text)));
  app.exit(0);
};
