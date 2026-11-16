// =====================================================================
//  Batería de pruebas automáticas del simulador de Melde (index.html)
//
//  Uso:   node pruebas/pruebas.mjs            (completa, ~8 min)
//         node pruebas/pruebas.mjs --rapido   (resistencia corta, ~4 min)
//         node pruebas/pruebas.mjs --semilla 1234
//
//  Requisitos: Node 22 o superior y Microsoft Edge o Google Chrome.
//  Abre index.html con file:// (igual que un doble clic) en un navegador
//  sin interfaz, lo maneja por el protocolo DevTools y comprueba la física,
//  la interfaz, la robustez ante entradas extremas, la memoria y los fallos
//  del entorno (sin GPU, sin CDN, sin fuentes, pérdida de contexto WebGL).
// =====================================================================
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ARGS = process.argv.slice(2);
const RAPIDO = ARGS.includes('--rapido');
const SEED = Number(ARGS[ARGS.indexOf('--semilla') + 1]) || (Date.now() % 100000);
const HERE = dirname(fileURLToPath(import.meta.url));
const URL_HTML = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const STRESS_MS = RAPIDO ? 45000 : 180000;
const SOLO = ARGS.includes('--solo') ? ARGS[ARGS.indexOf('--solo') + 1] : null;   // principal | entorno

if (typeof WebSocket === 'undefined') { console.error('Se necesita Node 22 o superior (WebSocket nativo).'); process.exit(2); }
const BROWSERS = [
  process.env.MELDE_NAVEGADOR,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter((p) => p && existsSync(p));
if (!BROWSERS.length) { console.error('No se encontró Edge ni Chrome. Define MELDE_NAVEGADOR con la ruta del ejecutable.'); process.exit(2); }
const BROWSER = BROWSERS[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*  Sesión de navegador sin interfaz controlada por DevTools           */
/* ------------------------------------------------------------------ */
class Session {
  constructor(name) { this.name = name; this.issues = []; this.id = 0; this.pending = new Map(); }

  static async open(name, { gl = 'gpu', width = 1600, height = 900, dpr = 1, mobile = false, media = [], block = [] } = {}) {
    const s = new Session(name);
    s.profile = mkdtempSync(join(tmpdir(), 'melde-pruebas-'));
    const glArgs = gl === 'software'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
    s.proc = spawn(BROWSER, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${s.profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--js-flags=--expose-gc', `--window-size=${width},${height}`, ...glArgs, 'about:blank',
    ], { stdio: 'ignore' });
    let port = null;
    for (let i = 0; i < 80 && !port; i++) {
      await sleep(150);
      try { port = readFileSync(join(s.profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
    }
    if (!port) throw new Error('El navegador no abrió el puerto de depuración');
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
      if (!wsUrl) await sleep(150);
    }
    s.ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { s.ws.addEventListener('open', r); s.ws.addEventListener('error', j); });
    s.ws.addEventListener('message', (ev) => s.onMessage(JSON.parse(ev.data)));
    await s.send('Runtime.enable'); await s.send('Log.enable'); await s.send('Page.enable'); await s.send('Network.enable');
    if (block.length) await s.send('Network.setBlockedURLs', { urls: block });
    if (media.length) await s.send('Emulation.setEmulatedMedia', { features: media });
    await s.viewport(width, height, dpr, mobile);
    if (mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    return s;
  }
  onMessage(m) {
    if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
    const p = m.params;
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(p.type))
      this.issues.push({ kind: 'console.' + p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    if (m.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      this.issues.push({ kind: 'excepción', text: `${d.exception?.description ?? d.text} @${d.url ?? ''}:${d.lineNumber}` });
    }
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(p.entry.level))
      this.issues.push({ kind: `log.${p.entry.level}/${p.entry.source}`, text: `${p.entry.text} ${p.entry.url ?? ''}`.trim() });
  }
  send(method, params = {}) {
    return new Promise((r) => { const i = ++this.id; this.pending.set(i, r); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async eval(expr, timeout = 120000) {
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      sleep(timeout).then(() => ({ timeout: true })),
    ]);
    if (r.timeout) throw new Error(`tiempo agotado (${timeout} ms)`);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  }
  async waitFor(expr, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (await this.eval(expr, 5000)) return true; } catch {} await sleep(150); }
    return false;
  }
  viewport(width, height, dpr = 1, mobile = false) {
    return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor(`document.readyState === 'complete'`, 30000);
  }
  async key(key, { code, vk, mods = 0, text } = {}) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: code ?? key, windowsVirtualKeyCode: vk ?? 0, modifiers: mods, text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code ?? key, windowsVirtualKeyCode: vk ?? 0, modifiers: mods });
  }
  // Tecleo real: enfoca la caja, borra con Ctrl+A y Retroceso, escribe y sale con Tab
  async typeInto(sel, text) {
    await this.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`);
    await this.key('a', { code: 'KeyA', vk: 65, mods: 2 });
    await this.key('Backspace', { code: 'Backspace', vk: 8 });
    if (text) await this.send('Input.insertText', { text });
    await this.key('Tab', { code: 'Tab', vk: 9 });
    await sleep(60);
  }
  async injectHelpers(seed) {
    await this.eval(`(() => {
      let a = ${seed} >>> 0;
      const rand = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
      window.T = {
        rand, rnd: (x, y) => x + rand() * (y - x), lrnd: (x, y) => Math.exp(Math.log(x) + rand() * (Math.log(y) - Math.log(x))),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        frames: (n = 1) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }),
        fin: (arr) => { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false; return true; },
        until: async (fn, ms = 5000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await T.frames(1); } return !!fn(); },
        text: () => ['#panel-left', '#panel-right', '.hud-tl', '.time-dock'].map((q) => document.querySelector(q).textContent).join(' '),
        click: (q) => document.querySelector(q).click(),
        async reset() {
          const M = window.__melde;
          if (M.S.paused) T.click('#btn-pause');
          T.click('[data-speed="1"]');
          for (const k of ['markers', 'vectors', 'envelope']) if (!M.S[k]) T.click('.tog[data-tog="' + k + '"]');
          M.setParam('mu', 1.621, 'ui'); M.setParam('L', 1, 'ui'); M.setParam('m', 0.25, 'ui'); M.setParam('f', 38.9, 'ui');
          T.click('[data-cam="iso"]');
          await T.until(() => !M.tweening && !M.sweeping, 4000);
        },
      };
      return true;
    })()`);
  }
  async close() {
    try { this.ws.close(); } catch {}
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else this.proc.kill('SIGKILL');
    for (let i = 0; i < 10; i++) { try { rmSync(this.profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
  }
}

/* ------------------------------------------------------------------ */
/*  Registro de resultados                                             */
/* ------------------------------------------------------------------ */
const results = [];
// Avisos que provoca la propia prueba (lectura de píxeles para comprobar que se dibuja), no la aplicación
const TEST_NOISE = [/GPU stall due to ReadPixels/i, /willReadFrequently/i];
async function test(s, name, fn, { allow = [] } = {}) {
  const t0 = Date.now(), before = s.issues.length;
  let ok = false, info = '';
  try { const r = await fn(); ok = !!r.ok; info = r.info ?? ''; }
  catch (e) { ok = false; info = 'error: ' + e.message; }
  const fresh = s.issues.slice(before).filter((i) => !TEST_NOISE.some((rx) => rx.test(i.text)) && !allow.some((rx) => rx.test(i.text)));
  if (fresh.length) { ok = false; info += ` | consola: ${fresh.length} mensaje(s): ` + fresh.slice(0, 3).map((i) => `[${i.kind}] ${i.text.slice(0, 160)}`).join(' ; '); }
  const ms = Date.now() - t0;
  results.push({ session: s.name, name, ok, info, ms });
  console.log(`${ok ? '  OK ' : ' FALLA'}  ${name}  (${(ms / 1000).toFixed(1)} s)${info ? '\n        ' + info : ''}`);
  return ok;
}
const J = (o) => JSON.stringify(o);

/* ------------------------------------------------------------------ */
/*  1. Sesión principal (GPU, 1600×900)                                */
/* ------------------------------------------------------------------ */
async function mainSession() {
  console.log(`\n▶ Sesión principal: ${BROWSER.split(/[\\/]/).pop()} con GPU, 1600×900`);
  const s = await Session.open('principal');
  try {
    await s.goto(URL_HTML);

    await test(s, 'Carga con file:// sin errores y dibuja la escena', async () => {
      const ready = await s.waitFor('window.__melde_ready === true', 25000);
      if (!ready) return { ok: false, info: 'no llegó a estar lista en 25 s' };
      await s.injectHelpers(SEED);
      const r = await s.eval(`(async () => { await T.frames(30); const snap = await __melde.snapshot();
        return { loader: document.getElementById('loader').classList.contains('done'), gpu: __melde.gpu(), snap, q: __melde.quality, gl: __melde.glName }; })()`);
      return { ok: r.loader && r.snap.std > 8 && r.gpu.size[0] > 0 && r.q === 'alta', info: `${r.gl}; calidad ${r.q}; canvas ${r.gpu.size.join('×')}, brillo medio ${r.snap.mean.toFixed(1)}, contraste ${r.snap.std.toFixed(1)}` };
    });

    await test(s, 'Calibración inicial: 38,9 Hz da 2 barrigas en resonancia', async () => {
      const r = await s.eval(`(async () => { await T.until(() => __melde.ampRel > 0.95, 6000); const M = __melde;
        return { S: [M.S.f, M.S.m, M.S.L, M.S.mu], st: M.P.state, n: M.P.nNear, amp: M.ampRel, dn: document.getElementById('d-n').textContent, chip: document.getElementById('status-txt').textContent }; })()`);
      return { ok: J(r.S) === J([38.9, 0.25, 1, 1.621]) && r.st === 'res' && r.n === 2 && r.amp > 0.95 && r.dn === '2' && r.chip === 'En resonancia', info: J(r) };
    });

    await test(s, 'Duplicar a 77,8 Hz da 4 barrigas en resonancia', async () => {
      const r = await s.eval(`(async () => { const n = document.getElementById('num-f'); n.value = '77.8';
        n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true }));
        await T.until(() => __melde.ampRel > 0.95, 6000); const M = __melde;
        return { st: M.P.state, n: M.P.nNear, f4: M.P.fNear, amp: M.ampRel, dn: document.getElementById('d-n').textContent }; })()`);
      return { ok: r.st === 'res' && r.n === 4 && Math.abs(r.f4 - 77.79) < 0.01 && r.dn === '4', info: J(r) };
    });

    await test(s, 'Tabla de modos: fₙ, λₙ y masa coinciden con la teoría (300 configuraciones)', async () => {
      const r = await s.eval(`(() => { const M = __melde; let bad = [], checks = 0;
        for (let k = 0; k < 300; k++) {
          const f = T.rnd(1, 200), m = T.rnd(0.02, 5), L = T.rnd(0.4, 3), mu = T.lrnd(0.05, 20);
          M.setParam('mu', mu, 'ui'); M.setParam('L', L, 'ui'); M.setParam('m', m, 'ui'); M.setParam('f', f, 'ui');
          const f1 = Math.sqrt(M.S.m * 9.81 / (M.S.mu / 1000)) / (2 * M.S.L);
          document.querySelectorAll('#modes-body tr').forEach((tr) => { const n = +tr.dataset.n; checks++;
            const fn = parseFloat(tr.querySelector('.fn').textContent), lam = parseFloat(tr.querySelector('.lam').textContent);
            if (Math.abs(fn - n * f1) > 0.006 || Math.abs(lam - 2 * M.S.L / n) > 0.0006) bad.push({ n, fn, exp: n * f1 });
            const mn = Math.pow(2 * M.S.L * M.S.f / n, 2) * (M.S.mu / 1000) / 9.81, pill = tr.querySelector('.mpill');
            if (mn >= 0.02 && mn <= 5) { if (Math.abs(parseFloat(pill.textContent) - mn) > 0.0006) bad.push({ n, m: pill.textContent, exp: mn }); }
            else if (!pill.disabled) bad.push({ n, pill: 'debería estar deshabilitada' });
          });
        }
        return { checks, bad: bad.slice(0, 3), nbad: bad.length }; })()`);
      await s.eval('T.reset()');
      return { ok: r.nbad === 0, info: `${r.checks} celdas verificadas${r.nbad ? ', errores: ' + J(r.bad) : ''}` };
    });

    await test(s, 'Respuesta lorentziana: pico, semiancho γ y valle entre armónicos', async () => {
      const r = await s.eval(`(() => { const M = __melde, P = M.P, out = [];
        const g = P.gamma, f1 = P.f1;
        for (let n = 1; n <= 6; n++) { const fn = n * f1;
          out.push({ n, pico: M.response(fn), menos: M.response(fn - g), mas: M.response(fn + g), tres: M.response(fn + 3 * g), valle: M.response((n + 0.5) * f1) }); }
        return { gOk: Math.abs(g - M.EPS * f1 / Math.PI) < 1e-12, out }; })()`);
      const bad = r.out.filter((o) => o.pico < 0.99 || Math.abs(o.menos - Math.SQRT1_2) > 0.03 || Math.abs(o.mas - Math.SQRT1_2) > 0.03 || Math.abs(o.tres - 1 / Math.sqrt(10)) > 0.03 || o.valle > 0.25);
      return { ok: r.gOk && !bad.length, info: bad.length ? J(bad) : `A(fₙ) ≥ 0,99, A(fₙ ± γ) ≈ 0,707, A(fₙ + 3γ) ≈ 0,316, valle < 0,25 en n = 1…6` };
    });

    await test(s, 'Forma del modo estable: envolvente ∝ |sin(nπx/L)| y nodos quietos (n = 1…6)', async () => {
      const r = await s.eval(`(async () => { const M = __melde, out = [];
        for (let n = 1; n <= 6; n++) {
          M.setParam('f', n * M.P.f1, 'ui'); await T.sleep(3200);
          const { NS, env } = M.field(), A = M.P.Avis; let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
          for (let i = 0; i <= NS; i++) { const x = env[i], y = Math.abs(Math.sin(n * Math.PI * i / NS)); sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
          const N = NS + 1, corr = (N * sxy - sx * sy) / Math.sqrt((N * sxx - sx * sx) * (N * syy - sy * sy));
          let nodeMax = 0; for (let j = 1; j < n; j++) nodeMax = Math.max(nodeMax, env[Math.round(j / n * NS)] / A);
          let mx = 0; for (let i = 0; i <= NS; i++) mx = Math.max(mx, env[i]);
          out.push({ n, corr: +corr.toFixed(4), nodo: +nodeMax.toFixed(3), max: +(mx / A).toFixed(3), st: M.P.state });
        }
        await T.reset(); return out; })()`);
      const bad = r.filter((o) => o.corr < 0.99 || o.nodo > 0.15 || o.max < 0.95 || o.max > 1.06 || o.st !== 'res');
      return { ok: !bad.length, info: bad.length ? J(bad) : 'correlación ≥ ' + Math.min(...r.map((o) => o.corr)) + ', amplitud en nodos ≤ ' + Math.max(...r.map((o) => o.nodo)) + ' A₀' };
    });

    await test(s, 'Ley de Melde en la tabla: mₙ·n² constante', async () => {
      const r = await s.eval(`(() => { const ms = [...document.querySelectorAll('#modes-body tr')].map((tr) => ({ n: +tr.dataset.n, m: parseFloat(tr.querySelector('.mpill').textContent) })).filter((o) => Number.isFinite(o.m));
        const k = ms.map((o) => o.m * o.n * o.n); return { k, dev: Math.max(...k) / Math.min(...k) - 1 }; })()`);
      return { ok: r.dev < 0.02, info: `mₙ·n² = ${r.k.map((v) => v.toFixed(3)).join(', ')} kg` };
    });

    await test(s, 'Auto-resonar sintoniza el armónico exacto (40 configuraciones aleatorias)', async () => {
      const r = await s.eval(`(async () => { const M = __melde, bad = []; let tuned = 0, none = 0;
        for (let k = 0; k < 40; k++) {
          M.setParam('mu', T.lrnd(0.05, 20), 'ui'); M.setParam('L', T.rnd(0.4, 3), 'ui'); M.setParam('m', T.rnd(0.02, 5), 'ui'); M.setParam('f', T.rnd(1, 200), 'ui');
          const f1 = Math.sqrt(M.S.m * 9.81 / (M.S.mu / 1000)) / (2 * M.S.L);
          const exists = Math.floor(200 / f1) >= Math.max(1, Math.ceil(1 / f1));
          const btn = document.getElementById('btn-auto');
          if (!exists) { if (!btn.disabled) bad.push({ k, f1, error: 'botón activo sin armónico disponible' }); none++; continue; }
          btn.click(); await T.until(() => !M.sweeping, 3000); await T.frames(2);
          const n = Math.round(M.S.f / f1);
          if (M.P.state !== 'res' || Math.abs(M.S.f - n * f1) > 1e-6 * n * f1 || M.S.f < 1 || M.S.f > 200) bad.push({ k, f: M.S.f, f1, st: M.P.state });
          else tuned++;
        }
        await T.reset(); return { tuned, none, bad: bad.slice(0, 3), nbad: bad.length }; })()`);
      return { ok: r.nbad === 0, info: `${r.tuned} sintonizadas, ${r.none} sin armónico en 1–200 Hz (botón deshabilitado)${r.nbad ? ' | ' + J(r.bad) : ''}` };
    });

    await test(s, 'Discos: la suma coincide con la masa para los 4981 valores de 0,020 a 5,000 kg', async () => {
      const r = await s.eval(`(() => { const M = __melde; let bad = [];
        for (let g = 20; g <= 5000; g++) { const sum = M.decompose(g / 1000).reduce((a, d) => a + d.g, 0) + 20; if (sum !== g) bad.push({ g, sum }); }
        return { bad: bad.slice(0, 5), nbad: bad.length }; })()`);
      return { ok: r.nbad === 0, info: r.nbad ? J(r.bad) : 'sin diferencias' };
    });

    await test(s, 'Pistón del excitador sincronizado con el extremo de la cuerda', async () => {
      const r = await s.eval(`(async () => { const M = __melde; let worst = 0, worst2 = 0;
        for (let k = 0; k < 40; k++) { await T.frames(1); const F = M.field();
          worst = Math.max(worst, Math.abs(M.rodY() - (F.ys[0] - M.YS)));
          worst2 = Math.max(worst2, Math.abs((F.ys[0] - M.YS) - (F.cuRe[0] * Math.cos(M.phase) - F.cuIm[0] * Math.sin(M.phase)))); }
        return { worst, worst2 }; })()`);
      return { ok: r.worst < 1e-9 && r.worst2 < 1e-5, info: `desfase máximo ${r.worst.toExponential(1)} m; respecto a Re[Y(0)e^{iωt}] ${r.worst2.toExponential(1)} m` };
    });

    await test(s, 'Valores extremos: 16 esquinas y 20 000 combinaciones aleatorias sin NaN ni Infinity', async () => {
      const r = await s.eval(`(async () => { const M = __melde, L = M.LIM, bad = []; const keys = ['f', 'm', 'L', 'mu'];
        const check = (tag) => { const P = M.P, F = M.field();
          const vals = [P.T, P.v, P.f1, P.nEff, P.lambda, P.k, P.omega, P.gamma, P.tau, P.R, P.Q, P.Avis, P.drive, P.fNear];
          if (!T.fin(vals) || P.R < 0 || P.R > 1.000001 || !['res', 'near', 'off'].includes(P.state)) bad.push({ tag, P: vals });
          M.computeTarget(); if (!T.fin(F.tgRe) || !T.fin(F.tgIm)) bad.push({ tag, campo: 'NaN' });
          const at = M.autoTarget(); if (at && (at.f < 1 - 1e-9 || at.f > 200 + 1e-9 || at.n < 1)) bad.push({ tag, at }); };
        const saved = keys.map((k) => M.S[k]);
        for (let c = 0; c < 16; c++) { keys.forEach((k, i) => (M.S[k] = L[k][(c >> i) & 1])); M.derive(); check('esquina ' + c); }
        for (let c = 0; c < 20000; c++) { M.S.f = T.rnd(1, 200); M.S.m = T.rnd(0.02, 5); M.S.L = T.rnd(0.4, 3); M.S.mu = T.lrnd(0.05, 20); M.derive(); check(c); if (bad.length > 5) break; }
        keys.forEach((k, i) => (M.S[k] = saved[i])); M.derive();
        // Ruta completa por la interfaz en las 16 esquinas: geometría, paneles y gráficas
        for (let c = 0; c < 16; c++) {
          keys.forEach((k, i) => M.setParam(k, L[k][(c >> i) & 1], 'ui')); await T.frames(3);
          const F = M.field(); const txt = T.text();
          if (!T.fin(F.ys) || !T.fin(F.env) || !T.fin(M.tube()) || /NaN|Infinity|undefined/.test(txt)) bad.push({ ui: c, NS: M.NS, txt: (txt.match(/.{0,30}(NaN|Infinity|undefined).{0,30}/) || [])[0] });
        }
        await T.reset(); return { bad: bad.slice(0, 4), nbad: bad.length }; })()`, 240000);
      return { ok: r.nbad === 0, info: r.nbad ? J(r.bad) : 'física, campo, geometría y paneles siempre finitos' };
    });

    await test(s, 'Entradas inválidas tecleadas (letras, vacío, negativos, fuera de rango, coma decimal)', async () => {
      const cases = [
        ['f', 'abc'], ['f', ''], ['f', '-5'], ['f', '999'], ['f', '1e3'], ['f', '0'], ['f', '38,9'], ['f', '38.9'], ['f', '200.0001'], ['f', '0.5'],
        ['m', '0'], ['m', '10'], ['m', '0,5'], ['m', '-1'], ['m', '0.0625'],
        ['L', '0.1'], ['L', '5'], ['L', '2,5'], ['L', 'x'],
        ['mu', '0'], ['mu', '-1'], ['mu', '25'], ['mu', '1,5'], ['mu', ''],
      ];
      const bad = [], seen = [];
      for (const [k, txt] of cases) {
        await s.typeInto('#num-' + k, txt);
        const r = await s.eval(`(() => { const M = __melde, v = M.S[${J(k)}], lim = M.LIM[${J(k)}], box = document.getElementById('num-' + ${J(k)}).value;
          return { v, box, inRange: Number.isFinite(v) && v >= lim[0] && v <= lim[1], boxOk: Math.abs(parseFloat(box) - v) < 1e-3 * Math.max(1, v) }; })()`);
        seen.push(`${k}="${txt}"→${+r.v.toFixed(4)}`);
        if (!r.inRange || !r.boxOk) bad.push({ k, txt, ...r });
      }
      await s.eval('T.reset()');
      return { ok: !bad.length, info: bad.length ? J(bad) : seen.join('  ') };
    });

    await test(s, 'Atajos de teclado: funcionan en la escena y no se disparan al escribir', async () => {
      await s.eval(`document.getElementById('num-f').focus()`);
      for (const [k, code, vk] of [['r', 'KeyR', 82], ['1', 'Digit1', 49], ['m', 'KeyM', 77], [' ', 'Space', 32]]) await s.key(k, { code, vk, text: k });
      const typing = await s.eval(`({ sweep: __melde.sweeping, cam: __melde.camMode, markers: __melde.S.markers, paused: __melde.S.paused, f: __melde.S.f })`);
      await s.key('Tab', { code: 'Tab', vk: 9 });
      await s.eval(`T.reset()`);
      await s.eval(`document.getElementById('gl').focus()`);
      const out = {};
      await s.key(' ', { code: 'Space', vk: 32, text: ' ' }); out.pausa = await s.eval('__melde.S.paused');
      await s.key(' ', { code: 'Space', vk: 32, text: ' ' }); out.reanuda = !(await s.eval('__melde.S.paused'));
      await s.key('1', { code: 'Digit1', vk: 49, text: '1' }); await sleep(1600); out.frontal = await s.eval('__melde.activeCam') === 'ortho';
      await s.key('3', { code: 'Digit3', vk: 51, text: '3' }); await sleep(1600); out.polea = await s.eval('__melde.camMode') === 'pulley';
      await s.key('2', { code: 'Digit2', vk: 50, text: '2' }); await sleep(1600); out.iso = await s.eval('__melde.camMode') === 'iso';
      await s.key('ArrowUp', { code: 'ArrowUp', vk: 38 }); await sleep(1200); out.arriba = await s.eval('__melde.P.nNear === 3 && __melde.P.state === "res"');
      await s.key('ArrowDown', { code: 'ArrowDown', vk: 40 }); await sleep(1200); out.abajo = await s.eval('__melde.P.nNear === 2 && __melde.P.state === "res"');
      await s.key('ArrowRight', { code: 'ArrowRight', vk: 39 }); out.derecha = await s.eval('Math.abs(__melde.S.f - 38.997) < 0.01');
      await s.key('r', { code: 'KeyR', vk: 82, text: 'r' }); await sleep(1200); out.r = await s.eval('__melde.P.state === "res" && Math.abs(__melde.S.f - 2 * __melde.P.f1) < 1e-6');
      for (const [k, code, vk] of [['m', 'KeyM', 77], ['v', 'KeyV', 86], ['e', 'KeyE', 69]]) await s.key(k, { code, vk, text: k });
      out.capas = await s.eval('!__melde.S.markers && !__melde.S.vectors && !__melde.S.envelope');
      await s.eval('T.reset()');
      const typingOk = !typing.sweep && typing.cam === 'iso' && typing.markers === true && typing.paused === false;
      return { ok: typingOk && Object.values(out).every(Boolean), info: `al escribir: ${typingOk ? 'sin efectos' : J(typing)}; en la escena: ${J(out)}` };
    });

    await test(s, 'Cámara: 60 cambios rápidos de vista sin quedar trabada', async () => {
      const r = await s.eval(`(async () => { const M = __melde, cams = ['front', 'iso', 'pulley'];
        for (let k = 0; k < 60; k++) { T.click('[data-cam="' + cams[Math.floor(T.rand() * 3)] + '"]'); await T.sleep(20 + T.rand() * 60); }
        T.click('[data-cam="front"]'); await T.until(() => !M.tweening, 3000); await T.frames(5);
        const a = { mode: M.camMode, cam: M.activeCam, c: M.camera() };
        T.click('[data-cam="iso"]'); await T.until(() => !M.tweening, 3000); await T.frames(5);
        const b = { mode: M.camMode, cam: M.activeCam, c: M.camera() };
        return { a, b, fin: T.fin([...a.c.p, ...a.c.t, ...b.c.p, ...b.c.t, a.c.zoom, b.c.zoom]) }; })()`);
      return { ok: r.fin && r.a.cam === 'ortho' && r.a.mode === 'front' && r.b.cam === 'persp' && r.b.mode === 'iso', info: `frontal → ${r.a.cam}, isométrica → ${r.b.cam}` };
    });

    await test(s, 'Pausa congela el tiempo y ±T/8 avanza exactamente π/4', async () => {
      const r = await s.eval(`(async () => { const M = __melde, back = document.getElementById('btn-back'), fwd = document.getElementById('btn-fwd');
        const disabledRunning = back.disabled && fwd.disabled;
        T.click('#btn-pause'); await T.frames(2); const t0 = M.simT, p0 = M.phase; await T.sleep(600); const frozen = M.simT === t0 && M.phase === p0;
        T.click('#btn-fwd'); const d1 = M.phase - p0; T.click('#btn-back'); T.click('#btn-back'); const d2 = M.phase - p0;
        T.click('#btn-pause'); await T.sleep(400); const resumed = M.simT > t0;
        return { disabledRunning, frozen, d1, d2, resumed }; })()`);
      const q = Math.PI / 4;
      return { ok: r.disabledRunning && r.frozen && Math.abs(r.d1 - q) < 1e-12 && Math.abs(r.d2 + q) < 1e-12 && r.resumed, info: J(r) };
    });

    await test(s, 'Velocidades 1,0× / 0,25× / 0,1× y estroboscopio', async () => {
      const r = await s.eval(`(async () => { const M = __melde, out = {};
        for (const sp of ['1', '0.25', '0.1']) { T.click('[data-speed="' + sp + '"]'); await T.frames(2); const t0 = M.simT, w0 = performance.now(); await T.sleep(1500); out[sp] = (M.simT - t0) / ((performance.now() - w0) / 1000); }
        T.click('[data-speed="strobe"]'); await T.frames(2); const p0 = M.phase, w0 = performance.now(); await T.sleep(1500); out.estrobo = (M.phase - p0) / ((performance.now() - w0) / 1000) / (2 * Math.PI);
        T.click('[data-speed="1"]'); return out; })()`);
      const near = (a, b) => Math.abs(a / b - 1) < 0.15;
      return { ok: near(r['1'], 1) && near(r['0.25'], 0.25) && near(r['0.1'], 0.1) && near(r.estrobo, 0.5), info: `tiempo simulado por segundo real: ${(+r['1']).toFixed(3)}, ${(+r['0.25']).toFixed(3)}, ${(+r['0.1']).toFixed(3)}; estrobo ${(+r.estrobo).toFixed(3)} Hz aparentes` };
    });

    await test(s, 'Capas: nodos/antinodos, vectores y envolvente se muestran y ocultan', async () => {
      const r = await s.eval(`(async () => { const M = __melde; await T.until(() => M.ampRel > 0.95, 4000); await T.sleep(800);
        const on = M.layers(); for (const k of ['markers', 'vectors', 'envelope']) T.click('.tog[data-tog="' + k + '"]'); await T.sleep(900);
        const off = M.layers(); for (const k of ['markers', 'vectors', 'envelope']) T.click('.tog[data-tog="' + k + '"]'); await T.sleep(900);
        return { on, off, again: M.layers() }; })()`);
      const allOn = (o) => o.band && o.arrows && o.labels && o.nodes, allOff = (o) => !o.band && !o.arrows && !o.labels && !o.nodes;
      return { ok: allOn(r.on) && allOff(r.off) && allOn(r.again), info: J(r) };
    });

    await test(s, 'Tabla interactiva: cada fila sintoniza su modo y cada masa lo produce', async () => {
      const r = await s.eval(`(async () => { const M = __melde, out = [];
        for (let n = 1; n <= 6; n++) { document.querySelector('#modes-body tr[data-n="' + n + '"] td').click(); await T.until(() => !M.sweeping, 3000); await T.frames(2);
          out.push({ n, fila: M.P.nNear === n && M.P.state === 'res' }); }
        M.setParam('f', 38.9, 'ui');
        for (let n = 1; n <= 6; n++) { const pill = document.querySelector('#modes-body tr[data-n="' + n + '"] .mpill'); if (pill.disabled) continue; pill.click(); await T.frames(2);
          out[n - 1].masa = M.P.nNear === n && M.P.R > 0.85; }
        await T.reset(); return out; })()`);
      const bad = r.filter((o) => !o.fila || o.masa === false);
      return { ok: !bad.length, info: bad.length ? J(bad) : '6 filas y 6 masas correctas' };
    });

    await test(s, 'Curva de resonancia: clic y arrastre en ambos modos fijan f dentro del rango', async () => {
      const r = await s.eval(`(async () => { const M = __melde, c = document.getElementById('spec-cv'), R = c.getBoundingClientRect(), out = [];
        for (const mode of ['zoom', 'global']) { T.click('[data-spec="' + mode + '"]');
          c.dispatchEvent(new PointerEvent('pointerdown', { clientX: R.left - 50, clientY: R.top + 40, pointerId: 7, bubbles: true }));
          for (let x = -50; x <= R.width + 50; x += 12) { c.dispatchEvent(new PointerEvent('pointermove', { clientX: R.left + x, clientY: R.top + 40, pointerId: 7, bubbles: true })); out.push(M.S.f); }
          c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true })); }
        T.click('[data-spec="zoom"]'); const ok = out.every((f) => Number.isFinite(f) && f >= 1 && f <= 200);
        await T.reset(); return { ok, min: Math.min(...out), max: Math.max(...out) }; })()`);
      return { ok: r.ok, info: `f recorrida entre ${r.min.toFixed(2)} y ${r.max.toFixed(2)} Hz` };
    });

    await test(s, 'Memoria GPU y JS: sin fugas tras 400 cambios de longitud, resolución y masa', async () => {
      const r = await s.eval(`(async () => { const M = __melde;
        M.setParam('m', 5, 'ui'); await T.frames(3); M.setParam('m', 1.908, 'ui'); await T.frames(3); await T.reset(); await T.sleep(1500);
        gc(); await T.frames(5); const g0 = M.gpu(), h0 = performance.memory.usedJSHeapSize;
        for (let k = 0; k < 150; k++) { M.setParam('L', T.rnd(0.4, 3), 'ui'); await T.frames(2); }
        for (let k = 0; k < 120; k++) { M.setParam('f', k % 2 ? 199 : 2, 'ui'); M.setParam('mu', k % 2 ? 20 : 0.05, 'ui'); await T.frames(1); }
        for (let k = 0; k < 130; k++) { M.setParam('m', T.rnd(0.02, 5), 'ui'); await T.frames(1); }
        await T.reset(); await T.sleep(2500); gc(); await T.frames(5); gc();
        const g1 = M.gpu(), h1 = performance.memory.usedJSHeapSize;
        return { g0, g1, dh: (h1 - h0) / 1048576 }; })()`, 180000);
      const dg = r.g1.geometries - r.g0.geometries, dt = r.g1.textures - r.g0.textures;
      return { ok: dg <= 2 && dt <= 0 && r.dh < 12, info: `geometrías ${r.g0.geometries}→${r.g1.geometries}, texturas ${r.g0.textures}→${r.g1.textures}, heap JS ${r.dh >= 0 ? '+' : ''}${r.dh.toFixed(1)} MB` };
    });

    await test(s, 'Ventana: 22 tamaños y densidades de píxel (de 320×480 a 3840×2160)', async () => {
      const sizes = [[320, 480, 2], [360, 640, 3], [390, 844, 2], [412, 915, 2.6], [768, 1024, 2], [820, 1180, 2], [1024, 600, 1], [1024, 768, 1], [1100, 700, 1], [1280, 720, 1], [1280, 800, 1.25], [1366, 768, 1], [1440, 900, 2], [1500, 900, 1], [1536, 864, 1.25], [1600, 300, 1], [300, 1600, 1], [1920, 1080, 1], [1920, 1200, 1.5], [2560, 1440, 1], [3840, 2160, 1], [1600, 900, 1]];
      const bad = [];
      for (const [w, h, d] of sizes) {
        await s.viewport(w, h, d); await sleep(350);
        const r = await s.eval(`(async () => { await T.frames(4); const M = __melde, c = document.getElementById('gl'), cam = M.camera(), dpr = M.renderPR;
          return { cw: c.width, ch: c.height, ew: Math.round(c.clientWidth * dpr), eh: Math.round(c.clientHeight * dpr), fin: T.fin([...cam.p, ...cam.t, cam.zoom, cam.aspect]),
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }; })()`);
        if (!r.fin || Math.abs(r.cw - r.ew) > 2 || Math.abs(r.ch - r.eh) > 2 || r.overflowX || r.cw < 1 || r.ch < 1) bad.push({ w, h, d, ...r });
      }
      return { ok: !bad.length, info: bad.length ? J(bad.slice(0, 3)) : `${sizes.length} tamaños sin desbordes, lienzo y cámara correctos` };
    });

    await test(s, 'Bloqueo de 3 s (pestaña oculta o equipo saturado): sin saltos ni valores rotos', async () => {
      const r = await s.eval(`(async () => { const M = __melde; await T.frames(2); const t0 = M.simT, w = performance.now();
        while (performance.now() - w < 3000) {}            // congela el hilo principal 3 s
        await T.frames(6); const F = M.field();
        return { dt: M.simT - t0, fin: T.fin(F.ys) && T.fin(M.tube()) && Number.isFinite(M.hangY()), hang: M.hangY() }; })()`);
      return { ok: r.fin && r.dt < 0.3 && r.hang > -0.4 && r.hang < -0.25, info: `tras 3 s bloqueado el tiempo simulado avanzó solo ${r.dt.toFixed(3)} s; portapesas estable en y = ${r.hang.toFixed(4)} m` };
    });

    await test(s, 'Reinicio de la GPU (pérdida de contexto WebGL): avisa y se recupera conservando el estado', async () => {
      await s.eval(`(async () => { const M = __melde; M.setParam('m', 0.5, 'ui'); M.setParam('L', 1.5, 'ui'); M.setParam('f', 77.8, 'ui');
        T.click('[data-speed="0.25"]'); T.click('[data-cam="front"]'); await T.until(() => !M.tweening, 3000);
        window.__old = true; const ext = document.getElementById('gl').getContext('webgl2').getExtension('WEBGL_lose_context');
        ext.loseContext(); setTimeout(() => ext.restoreContext(), 900); return true; })()`);
      await sleep(400);
      const notice = await s.eval(`document.querySelector('#loader .ld-txt').textContent`).catch(() => '');
      const back = await s.waitFor(`!window.__old && window.__melde_ready === true`, 25000);
      if (!back) return { ok: false, info: 'no se recuperó tras restaurar el contexto' };
      await s.injectHelpers(SEED + 1);
      const r = await s.eval(`(async () => { const M = __melde; await T.until(() => !M.tweening, 3000); await T.frames(30);
        return { S: [M.S.f, M.S.m, M.S.L], speed: M.speed, cam: M.camMode, active: M.activeCam, snap: await M.snapshot(), lost: M.gpu().lost }; })()`);
      await s.eval(`history.replaceState(null, '', location.pathname); true`);
      const kept = J(r.S) === J([77.8, 0.5, 1.5]) && r.speed === 0.25 && r.cam === 'front' && r.active === 'ortho';
      return { ok: /Recuperando/.test(notice) && kept && !r.lost && r.snap.std > 8, info: `aviso: "${notice}"; estado tras recuperar: f = ${r.S[0]} Hz, m = ${r.S[1]} kg, L = ${r.S[2]} m, velocidad ${r.speed}×, cámara ${r.cam}` };
    }, { allow: [/CONTEXT_LOST_WEBGL/i, /Context Lost/i, /Context Restored/i] });

    await test(s, 'Botón de calidad: alterna entre alta y ligera sin errores', async () => {
      const r = await s.eval(`(async () => { const M = __melde, c = document.getElementById('gl'), out = [];
        for (let k = 0; k < 4; k++) { T.click('#btn-q'); await T.frames(8); const snap = await M.snapshot();
          out.push({ q: M.quality, w: c.width, cw: c.clientWidth, pr: M.renderPR, std: +snap.std.toFixed(1), txt: document.getElementById('btn-q').textContent }); }
        return out; })()`);
      const ok = r[0].q === 'ligera' && r[1].q === 'alta' && r[2].q === 'ligera' && r[3].q === 'alta'
        && Math.abs(r[0].w - Math.round(r[0].cw * r[0].pr)) <= 2 && r[0].pr < 1 && r[1].w === r[1].cw && r.every((o) => o.std > 8);
      return { ok, info: r.map((o) => `${o.txt}: ${o.w} px`).join(' → ') };
    });

    await test(s, `Resistencia: ${STRESS_MS / 1000} s de uso aleatorio continuo`, async () => {
      const r = await s.eval(`(async () => { const M = __melde, cams = ['front', 'iso', 'pulley'], fps = [], acts = {};
        // Calentamiento: Three.js sube cada objeto a la GPU la primera vez que lo dibuja; se recorren todas las
        // vistas y todos los tamaños de disco para que la referencia incluya esas cachés acotadas.
        for (const m of [5, 1.908]) { M.setParam('m', m, 'ui'); await T.sleep(1800); }
        for (const c of ['front', 'pulley', 'iso']) { T.click('[data-cam="' + c + '"]'); await T.until(() => !M.tweening, 3000); await T.frames(10); }
        await T.reset(); await T.sleep(2500); await T.frames(5);
        gc(); const h0 = performance.memory.usedJSHeapSize, g0 = M.gpu().geometries, t0 = performance.now(); let f0 = M.frames, w0 = t0, bad = null;
        const A = [
          ['f', () => M.setParam('f', T.rnd(1, 200), 'ui')], ['m', () => M.setParam('m', T.rnd(0.02, 5), 'ui')],
          ['L', () => M.setParam('L', T.rnd(0.4, 3), 'ui')], ['mu', () => M.setParam('mu', T.lrnd(0.05, 20), 'ui')],
          ['cam', () => T.click('[data-cam="' + cams[Math.floor(T.rand() * 3)] + '"]')],
          ['vel', () => T.click('[data-speed="' + ['1', '0.25', '0.1', 'strobe'][Math.floor(T.rand() * 4)] + '"]')],
          ['pausa', () => T.click('#btn-pause')], ['capa', () => T.click('.tog[data-tog="' + ['markers', 'vectors', 'envelope'][Math.floor(T.rand() * 3)] + '"]')],
          ['auto', () => T.click('#btn-auto')], ['fila', () => document.querySelector('#modes-body tr[data-n="' + (1 + Math.floor(T.rand() * 6)) + '"] td').click()],
          ['espectro', () => T.click('[data-spec="' + (T.rand() < 0.5 ? 'zoom' : 'global') + '"]')],
        ];
        while (performance.now() - t0 < ${STRESS_MS}) {
          const [name, fn] = A[Math.floor(T.rand() * A.length)]; fn(); acts[name] = (acts[name] || 0) + 1;
          await T.sleep(250 + T.rand() * 700);
          const now = performance.now(); if (now - w0 > 3000) { fps.push((M.frames - f0) / ((now - w0) / 1000)); f0 = M.frames; w0 = now; }
          const F = M.field(); if (!T.fin(F.ys) || !T.fin(F.env) || !T.fin(M.camera().p) || !Number.isFinite(M.simT)) { bad = { name, NS: M.NS }; break; }
        }
        await T.reset(); await T.sleep(2500); gc(); await T.frames(5); gc();
        return { bad, acts, fps, q: M.quality, dh: (performance.memory.usedJSHeapSize - h0) / 1048576, dg: M.gpu().geometries - g0 }; })()`, STRESS_MS + 120000);
      const n = Object.values(r.acts).reduce((a, b) => a + b, 0);
      const minFps = Math.min(...r.fps), avgFps = r.fps.reduce((a, b) => a + b, 0) / r.fps.length;
      return { ok: !r.bad && r.dh < 15 && r.dg <= 2 && minFps > 30 && r.q === 'alta', info: `${n} acciones, calidad ${r.q}, FPS medio ${avgFps.toFixed(0)}, mínimo ${minFps.toFixed(0)}, heap JS ${r.dh >= 0 ? '+' : ''}${r.dh.toFixed(1)} MB, geometrías ${r.dg >= 0 ? '+' : ''}${r.dg}${r.bad ? ' | valor no finito tras ' + J(r.bad) : ''}` };
    });

    const all = s.issues.filter((i) => !TEST_NOISE.some((rx) => rx.test(i.text)) && !/CONTEXT_LOST_WEBGL|Context Lost|Context Restored/i.test(i.text));
    await test(s, 'Consola limpia durante toda la sesión principal', async () => ({ ok: all.length === 0, info: all.length ? all.slice(0, 5).map((i) => `[${i.kind}] ${i.text}`).join(' ; ') : '0 errores, 0 advertencias' }));
  } finally { await s.close(); }
}

/* ------------------------------------------------------------------ */
/*  2. Sesiones de entorno                                             */
/* ------------------------------------------------------------------ */
async function envSessions() {
  // Sin GPU: render por software
  console.log('\n▶ Sesión sin GPU (render por software SwiftShader)');
  let s = await Session.open('software', { gl: 'software' });
  try {
    await s.goto(URL_HTML);
    await test(s, 'Funciona sin aceleración gráfica', async () => {
      const ready = await s.waitFor('window.__melde_ready === true', 30000);
      if (!ready) return { ok: false, info: 'no cargó' };
      await s.injectHelpers(SEED);
      const r = await s.eval(`(async () => { await T.until(() => __melde.ampRel > 0.9, 15000); const f0 = __melde.frames, w0 = performance.now(); await T.sleep(4000);
        const snap = await __melde.snapshot(); return { fps: (__melde.frames - f0) / ((performance.now() - w0) / 1000), st: __melde.P.state, snap, q: __melde.quality, gl: __melde.glName,
          btn: document.getElementById('btn-q').textContent }; })()`);
      return { ok: r.st === 'res' && r.snap.std > 8 && r.fps >= 12 && r.q === 'ligera', info: `${r.gl}: ${r.fps.toFixed(0)} FPS con CPU, "${r.btn}", estado ${r.st}` };
    }, { allow: [/software WebGL|SwiftShader/i] });
  } finally { await s.close(); }

  // Movimiento reducido (accesibilidad)
  console.log('\n▶ Sesión con "reducir movimiento" activado en el sistema');
  s = await Session.open('reduced', { media: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    await s.goto(URL_HTML);
    await test(s, 'Con movimiento reducido: transiciones instantáneas y todo funcional', async () => {
      if (!(await s.waitFor('window.__melde_ready === true', 25000))) return { ok: false, info: 'no cargó' };
      await s.injectHelpers(SEED);
      const r = await s.eval(`(async () => { const M = __melde; await T.frames(3);
        document.querySelector('#modes-body tr[data-n="4"] td').click(); const instF = !M.sweeping && M.P.nNear === 4;
        T.click('[data-cam="front"]'); await T.frames(2); const instC = !M.tweening && M.activeCam === 'ortho';
        M.setParam('m', 3.5, 'ui'); await T.frames(2); await T.until(() => M.ampRel > 0.9, 6000);
        return { instF, instC, discs: M.discMeshes(), st: M.P.state }; })()`);
      return { ok: r.instF && r.instC && r.discs > 0, info: J(r) };
    });
  } finally { await s.close(); }

  // Fuentes de Google bloqueadas
  console.log('\n▶ Sesión sin acceso a Google Fonts');
  s = await Session.open('nofonts', { block: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] });
  try {
    await s.goto(URL_HTML);
    await test(s, 'Sin fuentes web: usa las del sistema y funciona igual', async () => {
      if (!(await s.waitFor('window.__melde_ready === true', 25000))) return { ok: false, info: 'no cargó' };
      await s.injectHelpers(SEED);
      const r = await s.eval(`(async () => { await T.until(() => __melde.ampRel > 0.95, 6000); return { st: __melde.P.state, snap: await __melde.snapshot() }; })()`);
      return { ok: r.st === 'res' && r.snap.std > 8, info: `estado ${r.st}` };
    }, { allow: [/fonts\.(googleapis|gstatic)\.com|ERR_BLOCKED_BY_CLIENT/i] });
  } finally { await s.close(); }

  // CDN de Three.js bloqueada (sin Internet o cortafuegos)
  console.log('\n▶ Sesión sin acceso a la CDN de Three.js');
  s = await Session.open('nocdn', { block: ['*cdn.jsdelivr.net*'] });
  try {
    const t0 = Date.now();
    await s.goto(URL_HTML);
    await test(s, 'Sin CDN: muestra un aviso claro en lugar de quedarse colgado', async () => {
      const shown = await s.waitFor(`document.getElementById('loader').classList.contains('err')`, 20000);
      const txt = await s.eval(`document.querySelector('#loader .ld-txt').textContent`);
      const secs = (Date.now() - t0) / 1000;
      const exc = s.issues.filter((i) => i.kind === 'excepción' && !/Failed to fetch|import|module/i.test(i.text));
      return { ok: shown && /No se pudo cargar Three\.js/.test(txt) && !exc.length, info: `aviso visible en ${secs.toFixed(1)} s: "${txt.slice(0, 70)}…"` };
    }, { allow: [/jsdelivr|ERR_BLOCKED_BY_CLIENT|Failed to fetch|module/i] });
  } finally { await s.close(); }

  // Teléfono con pantalla táctil
  console.log('\n▶ Sesión de teléfono (390×844, densidad 3, táctil)');
  s = await Session.open('movil', { width: 390, height: 844, dpr: 3, mobile: true });
  try {
    await s.goto(URL_HTML);
    await test(s, 'Teléfono: carga, sin desbordes horizontales y controles accesibles', async () => {
      if (!(await s.waitFor('window.__melde_ready === true', 25000))) return { ok: false, info: 'no cargó' };
      await s.injectHelpers(SEED);
      const r = await s.eval(`(async () => { await T.until(() => __melde.ampRel > 0.95, 6000);
        const vis = (q) => { const e = document.querySelector(q), b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.right <= innerWidth + 1; };
        return { st: __melde.P.state, ov: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          controls: ['#num-f', '#rng-m', '#btn-auto', '#btn-pause', '#scope-cv', '#modes-body'].every(vis), snap: await __melde.snapshot() }; })()`);
      return { ok: r.st === 'res' && !r.ov && r.controls && r.snap.std > 8, info: J({ estado: r.st, desborde: r.ov, controles: r.controls }) };
    });
  } finally { await s.close(); }
}

/* ------------------------------------------------------------------ */
const T0 = Date.now();
console.log(`Simulador de Melde: batería de pruebas`);
console.log(`Archivo: ${URL_HTML}\nNavegador: ${BROWSER}\nSemilla aleatoria: ${SEED} (repite exactamente esta corrida con --semilla ${SEED})`);
try { if (!SOLO || SOLO === 'principal') await mainSession(); if (!SOLO || SOLO === 'entorno') await envSessions(); }
catch (e) { console.error('\nError del ejecutor de pruebas:', e); results.push({ name: 'ejecutor', ok: false, info: e.message }); }
const fails = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(70)}\n${results.length - fails.length} de ${results.length} pruebas superadas en ${((Date.now() - T0) / 60000).toFixed(1)} min`);
if (fails.length) { console.log('Fallaron:'); for (const f of fails) console.log(`  - ${f.name}: ${f.info}`); }
process.exit(fails.length ? 1 : 0);
