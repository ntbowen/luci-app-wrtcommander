/*
 * Row-interaction regression test for the LuCI view.
 *
 * Loads the *real* view module into a headless browser the way LuCI's
 * loader does - strip the 'require x' statements, wrap the body, hand it
 * stubbed view/rpc/ui/dom modules - and then clicks on it. The backend is
 * a fake directory tree in the harness, so this needs no router.
 *
 * What it guards: a click opens a row, a stray second tap does not open a
 * second time (the list under the finger has already been replaced),
 * Ctrl-click marks a row instead of opening it, and turning the setting
 * off puts double-click behaviour back.
 *
 * Needs node and playwright, which a router does not have - the shell
 * wrapper skips it there.
 *
 *   node ui-click-test.js
 *   PLAYWRIGHT=/path/to/playwright CHROMIUM=/path/to/chrome node ui-click-test.js
 */
const path = require('path');
const fs = require('fs');

const PLAYWRIGHT = process.env.PLAYWRIGHT || 'playwright';
const CHROMIUM = process.env.CHROMIUM || undefined;
const { chromium } = require(PLAYWRIGHT);

const SRC = path.resolve(__dirname,
  '../htdocs/luci-static/resources/view/wrtcommander.js');

// a small archive built by python's zipfile - see the ZIP block below
const ZIP_B64 =
  'UEsDBBQAAAAAAAAAIQCGphA2BQAAAAUAAAAPAAAAc2l0ZS9pbmRleC5odG1saGVsbG9QSwMEFAAA' +
  'AAgAAAAhAIXflVsYAAAAWAIAABEAAABzaXRlL2Nzcy9tYWluLmNzc0vKT6msTs7PyS+yKkpNqU0a' +
  '5Y5yqcEFAFBLAwQUAAAACAAAACEAaP4BQxAAAAAOAAAADgAAAHNpdGUvanMvYXBwLmpzS87PK87P' +
  'SdXLyU/XMNQEAFBLAwQUAAAIAAAAACEAI2QnpxIAAAASAAAAIgAAAHNpdGUv0YTQvtGC0L4v0YHQ' +
  'vdC40LzQvtC6ICgxKS50eHTQutC40YDQuNC70LvQuNGG0LBQSwMEFAAAAAAAAAAhAKqCySsIAAAA' +
  'CAAAAA0AAABzaXRlL2NhZoIudHh0ZXNwcmVzc29QSwMEFAAAAAAAAAAhAAAAAAAAAAAAAAAAAAsA' +
  'AABzaXRlL2VtcHR5L1BLAwQUAAAAAAAAACEAzKnOVwoAAAAKAAAAFQAAAGV2aWwvLi4vLi4vZXRj' +
  'L3Bhc3N3ZHJvb3Q6eDowOjBQSwECFAMUAAAAAAAAACEAhqYQNgUAAAAFAAAADwAAAAAAAAAAAAAA' +
  'gAEAAAAAc2l0ZS9pbmRleC5odG1sUEsBAhQDFAAAAAgAAAAhAIXflVsYAAAAWAIAABEAAAAAAAAA' +
  'AAAAAIABMgAAAHNpdGUvY3NzL21haW4uY3NzUEsBAhQDFAAAAAgAAAAhAGj+AUMQAAAADgAAAA4A' +
  'AAAAAAAAAAAAAIABeQAAAHNpdGUvanMvYXBwLmpzUEsBAhQDFAAACAAAAAAhACNkJ6cSAAAAEgAA' +
  'ACIAAAAAAAAAAAAAAIABtQAAAHNpdGUv0YTQvtGC0L4v0YHQvdC40LzQvtC6ICgxKS50eHRQSwEC' +
  'FAMUAAAAAAAAACEAqoLJKwgAAAAIAAAADQAAAAAAAAAAAAAAgAEHAQAAc2l0ZS9jYWaCLnR4dFBL' +
  'AQIUAxQAAAAAAAAAIQAAAAAAAAAAAAAAAAALAAAAAAAAAAAAEADtQToBAABzaXRlL2VtcHR5L1BL' +
  'AQIUAxQAAAAAAAAAIQDMqc5XCgAAAAoAAAAVAAAAAAAAAAAAAACAAWMBAABldmlsLy4uLy4uL2V0' +
  'Yy9wYXNzd2RQSwUGAAAAAAcABwC/AQAAoAEAAAAA';

let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
  if (!ok) fail++;
};

(async () => {
  const b = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
  p.on('pageerror', e => { console.log('  PAGE ERROR: ' + e.message); fail++; });
  await p.goto('file://' + path.resolve(__dirname, 'ui-click-harness.html'));

  const src = fs.readFileSync(SRC, 'utf8');
  await p.evaluate(s => window.__boot(s), src);
  await p.waitForTimeout(300);

  const leftPath = () => p.$eval('.fx-pane:nth-child(1) .fx-path-input', e => e.value);
  const rows = () => p.$$eval('.fx-pane:nth-child(1) .fx-item .fx-nm', ns => ns.map(n => n.textContent));
  const setPref = (k, v) => p.evaluate(([k, v]) => { window.__view[k] = v; }, [k, v]);
  const nav = async (to) => {
    await p.evaluate(t => window.__view.navigate('left', t), to);
    await p.waitForTimeout(150);
  };
  // a deliberate click: a person has looked at the new list first, so
  // leave the guard's window behind before clicking again
  const clickRow = async (name) => {
    await p.waitForTimeout(300);
    await p.evaluate(n => {
      const el = [...document.querySelectorAll('.fx-pane:nth-child(1) .fx-item')]
        .find(r => r.querySelector('.fx-nm').textContent.startsWith(n));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    }, name);
    await p.waitForTimeout(150);
  };

  console.log('single-click mode (the default)');
  const dflt = await p.evaluate(() => window.__view.singleClick);
  check('singleClick defaults to on', dflt === true, 'value=' + dflt);

  await nav('/');
  check('starts at /', (await leftPath()) === '/', await leftPath());

  await clickRow('etc');
  check('one click on a folder opens it', (await leftPath()) === '/etc', await leftPath());

  await clickRow('config');
  check('and again, one level deeper', (await leftPath()) === '/etc/config', await leftPath());

  // the "up" row, one click
  await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelector('.fx-pane:nth-child(1) .fx-updir')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  await p.waitForTimeout(150);
  check('one click on ".." goes up one level', (await leftPath()) === '/etc', await leftPath());

  console.log('the double-tap guard');
  await nav('/');
  // two clicks in quick succession on the SAME row: must land one level down,
  // not two - the second click lands on a list that no longer holds that row
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.fx-pane:nth-child(1) .fx-item')]
      .find(r => r.querySelector('.fx-nm').textContent.startsWith('etc'));
    row.dispatchEvent(new MouseEvent('click',    { bubbles: true, detail: 1 }));
    row.dispatchEvent(new MouseEvent('click',    { bubbles: true, detail: 2 }));
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  });
  await p.waitForTimeout(250);
  check('a double tap opens once, not twice', (await leftPath()) === '/etc', await leftPath());

  // and ".." twice quickly must not climb two levels
  await nav('/etc/config');
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const u = document.querySelector('.fx-pane:nth-child(1) .fx-updir');
    u.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    u.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
  });
  await p.waitForTimeout(250);
  check('a double tap on ".." climbs one level', (await leftPath()) === '/etc', await leftPath());

  // a touch stack that never sets `detail`: the time window is the only
  // thing standing between a stray second tap and a second open
  await nav('/');
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.fx-pane:nth-child(1) .fx-item')]
      .find(r => r.querySelector('.fx-nm').textContent.startsWith('etc'));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  });
  await p.waitForTimeout(250);
  check('a double tap with no click counter still opens once',
    (await leftPath()) === '/etc', await leftPath());

  console.log('opening a file');
  await p.waitForTimeout(500);   // let the guard lapse
  await nav('/etc');
  await clickRow('passwd');
  const modal = await p.evaluate(() => {
    const m = document.getElementById('the-modal');
    return m ? m.getAttribute('data-title') : null;
  });
  check('one click on a file opens the viewer', modal === '/etc/passwd', 'modal=' + modal);
  await p.evaluate(() => document.getElementById('the-modal').remove());

  console.log('ctrl-click marks instead of opening');
  await p.waitForTimeout(500);
  await nav('/');
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.fx-pane:nth-child(1) .fx-item')]
      .find(r => r.querySelector('.fx-nm').textContent.startsWith('etc'));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }));
  });
  await p.waitForTimeout(150);
  check('ctrl-click does not navigate', (await leftPath()) === '/', await leftPath());
  const marked = await p.evaluate(() => Object.keys(window.__view.panes.left.selected));
  check('ctrl-click marks the row', marked.length === 1 && marked[0] === '/etc', JSON.stringify(marked));
  // and again to unmark
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.fx-pane:nth-child(1) .fx-item')]
      .find(r => r.querySelector('.fx-nm').textContent.startsWith('etc'));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }));
  });
  await p.waitForTimeout(150);
  const marked2 = await p.evaluate(() => Object.keys(window.__view.panes.left.selected));
  check('ctrl-click again unmarks it', marked2.length === 0, JSON.stringify(marked2));

  console.log('double-click mode, turned off through the settings dialog');
  await p.evaluate(() => window.__view.actSettings());
  await p.waitForTimeout(150);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('#the-modal .fx-set-row')]
      .find(r => { const l = r.querySelector('.fx-set-label');
                   return l && l.textContent === 'Open with a single click'; });
    const cb = row.querySelector('input[type=checkbox]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const storedOff = await p.evaluate(() => window.localStorage.getItem('wrtcommander.singleClick'));
  check('unticking it is stored', storedOff === 'false', 'stored=' + storedOff);
  const propOff = await p.evaluate(() => window.__view.singleClick);
  check('and the view followed', propOff === false, 'value=' + propOff);
  await p.evaluate(() => { const m = document.getElementById('the-modal'); if (m) m.remove(); });
  await p.waitForTimeout(300);
  await nav('/');
  await clickRow('etc');
  check('one click no longer opens', (await leftPath()) === '/', await leftPath());
  const cursor = await p.evaluate(() => window.__view.panes.left.cursor);
  check('but the cursor still moved', typeof cursor === 'number', 'cursor=' + cursor);
  await p.evaluate(() => {
    const row = [...document.querySelectorAll('.fx-pane:nth-child(1) .fx-item')]
      .find(r => r.querySelector('.fx-nm').textContent.startsWith('etc'));
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  });
  await p.waitForTimeout(200);
  check('a double click still opens', (await leftPath()) === '/etc', await leftPath());

  console.log('the switch is where a user can find it');
  await p.evaluate(() => window.__view.actSettings());
  await p.waitForTimeout(150);
  const labels = await p.$$eval('#the-modal .fx-set-label', ns => ns.map(n => n.textContent));
  check('settings dialog lists the switch',
    labels.indexOf('Open with a single click') >= 0, JSON.stringify(labels));
  const groups = await p.$$eval('#the-modal .fx-set-group-title', ns => ns.map(n => n.textContent));
  check('under a group of its own', groups.indexOf('Behaviour') >= 0, JSON.stringify(groups));

  // ---------------------------------------------------------- uploads
  //
  // A folder upload is driven entirely from the browser: create every
  // directory, then POST one file per request to the directory it
  // belongs in. These check the shape of what the view sends, since that
  // is the whole of the feature - the router side is unchanged.
  console.log('folder upload');
  await p.evaluate(() => { window.__uploads = []; window.__calls = []; });
  await nav('/tmp');

  const tree = [
    ['site/index.html', 'a'],
    ['site/css/main.css', 'bb'],
    ['site/css/img/logo.png', 'ccc'],
    ['site/js/app.js', 'dddd']
  ];
  await p.evaluate(t => {
    const files = t.map(([rel, body]) => {
      const f = new File([body], rel.split('/').pop(), { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: rel });
      return f;
    });
    return window.__view.uploadTree(files, '/tmp', 'left');
  }, tree);
  await p.waitForTimeout(600);

  const mkdirs = await p.evaluate(() =>
    window.__calls.filter(c => c.method === 'mkdir').map(c => c.args[0]));
  check('creates every directory in the tree',
    JSON.stringify(mkdirs) === JSON.stringify(
      ['/tmp/site', '/tmp/site/css', '/tmp/site/js', '/tmp/site/css/img']),
    JSON.stringify(mkdirs));
  check('parents before children',
    mkdirs.every((d, i) => i === 0 || d.split('/').length >= mkdirs[i - 1].split('/').length),
    JSON.stringify(mkdirs));

  const ups = await p.evaluate(() => window.__uploads);
  check('one request per file', ups.length === 4, 'n=' + ups.length);
  const placed = ups.map(u => u.dest + '/' + u.name).sort();
  check('each file lands in its own directory',
    JSON.stringify(placed) === JSON.stringify([
      '/tmp/site/css/img/logo.png', '/tmp/site/css/main.css',
      '/tmp/site/index.html', '/tmp/site/js/app.js'].sort()),
    JSON.stringify(placed));
  check('nothing is sent with overwrite set', ups.every(u => !u.overwrite));

  console.log('a path that tries to climb out is dropped, not sent');
  await p.evaluate(() => { window.__uploads = []; window.__calls = []; });
  await p.evaluate(() => {
    const mk = (rel) => {
      const f = new File(['x'], rel.split('/').pop(), { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: rel });
      return f;
    };
    return window.__view.uploadTree([mk('evil/../../etc/passwd'), mk('ok/fine.txt')], '/tmp', 'left');
  });
  await p.waitForTimeout(400);
  const ups2 = await p.evaluate(() => window.__uploads);
  const mk2 = await p.evaluate(() =>
    window.__calls.filter(c => c.method === 'mkdir').map(c => c.args[0]));
  check('the ".." file is dropped', ups2.length === 1 && ups2[0].name === 'fine.txt',
    JSON.stringify(ups2.map(u => u.dest + '/' + u.name)));
  check('and no directory is created for it',
    JSON.stringify(mk2) === JSON.stringify(['/tmp/ok']), JSON.stringify(mk2));
  await p.evaluate(() => { const m = document.getElementById('the-modal'); if (m) m.remove(); });

  console.log('re-uploading over what is already there');
  await p.evaluate(() => {
    window.__uploads = []; window.__calls = [];
    window.__existing = { '/tmp/site/index.html': true, '/tmp/site/js/app.js': true };
  });
  await p.evaluate(t => {
    const files = t.map(([rel, body]) => {
      const f = new File([body], rel.split('/').pop(), { type: 'text/plain' });
      Object.defineProperty(f, 'webkitRelativePath', { value: rel });
      return f;
    });
    return window.__view.uploadTree(files, '/tmp', 'left');
  }, tree);
  await p.waitForTimeout(600);

  const prompt = await p.evaluate(() => {
    const m = document.getElementById('the-modal');
    return m ? m.getAttribute('data-title') : null;
  });
  check('the first clash prompts once', prompt === 'File already exists', 'modal=' + prompt);
  const hasAll = await p.evaluate(() =>
    !!document.querySelector('#the-modal input[type=checkbox]'));
  check('the prompt offers "apply to the rest"', hasAll === true);

  // tick "apply to the rest" and overwrite: the second clash must not ask
  await p.evaluate(() => {
    document.querySelector('#the-modal input[type=checkbox]').checked = true;
    const btns = [...document.querySelectorAll('#the-modal button')];
    btns.find(b => b.textContent === 'Overwrite').click();
  });
  await p.waitForTimeout(600);
  const stillOpen = await p.evaluate(() => {
    const m = document.getElementById('the-modal');
    return m ? m.getAttribute('data-title') : null;
  });
  check('the second clash is not prompted again',
    stillOpen !== 'File already exists', 'modal=' + stillOpen);
  // "apply to the rest" means exactly that: everything from the answer
  // onwards carries the overwrite flag, clash or not, so a re-uploaded
  // folder costs one request per file rather than two.
  const ups3 = await p.evaluate(() => window.__uploads);
  const forced = ups3.filter(u => u.overwrite).map(u => u.name).sort();
  check('both files that clashed are re-sent with overwrite',
    forced.indexOf('index.html') >= 0 && forced.indexOf('app.js') >= 0,
    JSON.stringify(forced));
  const landed = await p.evaluate(() => Object.keys(window.__existing).sort());
  check('and the whole tree ends up on the router',
    JSON.stringify(landed) === JSON.stringify([
      '/tmp/site/css/img/logo.png', '/tmp/site/css/main.css',
      '/tmp/site/index.html', '/tmp/site/js/app.js'].sort()),
    JSON.stringify(landed));

  console.log('the plain file upload still goes to the current directory');
  await p.evaluate(() => { window.__uploads = []; window.__existing = {}; });
  await p.evaluate(() => {
    const f = new File(['z'], 'loose.txt', { type: 'text/plain' });
    return window.__view.uploadFiles([{ file: f, dest: '/tmp', label: 'loose.txt' }], '/tmp', 'left', []);
  });
  await p.waitForTimeout(400);
  const ups4 = await p.evaluate(() => window.__uploads);
  check('one file, one request, no mkdir',
    ups4.length === 1 && ups4[0].dest === '/tmp' && ups4[0].name === 'loose.txt',
    JSON.stringify(ups4));


  // ------------------------------------------------------------ ZIP
  //
  // The route a phone has to use, since no mobile browser can pick a
  // folder. The archive below is built by python's zipfile and holds one
  // of everything that matters: a stored entry, two deflated ones, a
  // UTF-8 flagged Cyrillic name, an explicit empty-directory entry, and
  // an entry whose name tries to climb out of the destination.
  console.log('uploading a folder from a ZIP');
  await p.evaluate(() => {
    window.__uploads = []; window.__calls = []; window.__existing = {};
  });
  await nav('/tmp');
  await p.evaluate(b64 => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f = new File([bytes], 'site.zip', { type: 'application/zip' });
    return window.__view.openZip(f, '/tmp', 'left');
  }, ZIP_B64);
  await p.waitForTimeout(400);

  const zipTitle = await p.evaluate(() => {
    const m = document.getElementById('the-modal');
    return m ? m.getAttribute('data-title') : null;
  });
  check('the archive is read and confirmed first',
    zipTitle === 'Upload folder from a ZIP', 'modal=' + zipTitle);
  const summary = await p.evaluate(() =>
    [...document.querySelectorAll('#the-modal p')].map(n => n.textContent));
  check('the summary counts what will be written',
    summary.some(t => t === 'Files: 5, folders: 5'), JSON.stringify(summary));
  check('and says one entry is being skipped',
    summary.some(t => t.indexOf('Skipping 1 entry') === 0), JSON.stringify(summary));
  check('nothing is written before the confirmation',
    (await p.evaluate(() => window.__uploads.length)) === 0);

  await p.evaluate(() => {
    [...document.querySelectorAll('#the-modal button')]
      .find(b => b.textContent === 'Upload').click();
  });
  await p.waitForTimeout(900);

  const zdirs = await p.evaluate(() =>
    window.__calls.filter(c => c.method === 'mkdir').map(c => c.args[0]));
  check('every folder in the archive is created, shallowest first',
    JSON.stringify(zdirs) === JSON.stringify(['/tmp/site', '/tmp/site/css',
      '/tmp/site/empty', '/tmp/site/js', '/tmp/site/\u0444\u043e\u0442\u043e']),
    JSON.stringify(zdirs));
  check('an empty folder in the archive is created too',
    zdirs.indexOf('/tmp/site/empty') >= 0, JSON.stringify(zdirs));

  const zups = await p.evaluate(() => window.__uploads);
  const zplaced = zups.map(u => u.dest + '/' + u.name).sort();
  check('every file lands where the archive put it',
    JSON.stringify(zplaced) === JSON.stringify([
      '/tmp/site/css/main.css', '/tmp/site/index.html', '/tmp/site/js/app.js',
      '/tmp/site/caf\u00e9.txt',
      '/tmp/site/\u0444\u043e\u0442\u043e/\u0441\u043d\u0438\u043c\u043e\u043a (1).txt'].sort()),
    JSON.stringify(zplaced));
  check('the "../" entry never reaches the router',
    !zups.some(u => u.name === 'passwd') && !zdirs.some(d => d.indexOf('evil') >= 0));

  const stored = zups.find(u => u.name === 'index.html');
  check('a stored entry comes out byte for byte',
    stored && stored.text === 'hello', stored && JSON.stringify(stored.text));
  const deflated = zups.find(u => u.name === 'main.css');
  check('a deflated entry is inflated by the browser',
    deflated && deflated.text === 'body{color:red}'.repeat(40) && deflated.size === 600,
    deflated && ('size=' + deflated.size));
  const cyr = zups.find(u => u.name.indexOf('(1).txt') >= 0);
  check('a UTF-8 flagged name is decoded',
    cyr && cyr.name === '\u0441\u043d\u0438\u043c\u043e\u043a (1).txt' && cyr.text === '\u043a\u0438\u0440\u0438\u043b\u043b\u0438\u0446\u0430',
    cyr && JSON.stringify(cyr.name));

  // the entry above carries CP437 bytes and no UTF-8 flag, the way an
  // older Windows zip writes a name - that is what the CP437 table is for
  const legacy = zups.find(u => u.name.indexOf('caf') === 0);
  check('a name with no UTF-8 flag is decoded as CP437',
    legacy && legacy.name === 'caf\u00e9.txt' && legacy.text === 'espresso',
    legacy && JSON.stringify(legacy.name));

  console.log('a file that is not an archive');
  await p.evaluate(() => { window.__uploads = []; });
  await p.evaluate(() => {
    const f = new File(['this is not a zip at all, not even close'], 'notes.txt');
    return window.__view.openZip(f, '/tmp', 'left');
  });
  await p.waitForTimeout(300);
  check('is refused, and nothing is uploaded',
    (await p.evaluate(() => window.__uploads.length)) === 0);
  const noModal = await p.evaluate(() => !document.getElementById('the-modal'));
  check('and the dialog is closed rather than left hanging', noModal === true);

  console.log('the folder picker is not offered where it cannot work');
  const picker = await p.evaluate(() => window.__view.folderPickerSupported());
  check('a desktop viewport is offered the folder picker', picker === true);
  const phone = await b.newPage({ viewport: { width: 390, height: 780 },
                                  hasTouch: true, isMobile: true });
  await phone.goto('file://' + path.resolve(__dirname, 'ui-click-harness.html'));
  await phone.evaluate(s => window.__boot(s), src);
  await phone.waitForTimeout(200);
  const phonePicker = await phone.evaluate(() => window.__view.folderPickerSupported());
  check('a touch-primary device is not', phonePicker === false);
  await phone.close();

  console.log('\n== ' + (fail ? fail + ' FAILED' : 'all passed') + ' ==');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
