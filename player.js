(function() {
// player.js — Moteur de lecture partagé entre index.html et pack.html (LayerPitch)
// Un seul endroit pour le rendu des morceaux et toute la logique audio (bouclage simple + quantifié, stingers, intensité).
// Chargé comme script classique (<script src="player.js"></script>) — fonctionne en file:// comme en https://,
// contrairement aux modules ES qui sont bloqués par les navigateurs en ouverture locale directe.

const ctx = new (window.AudioContext || window.webkitAudioContext)();

// Contournement de l'interrupteur silencieux physique sur iOS Safari : le Web Audio API respecte cet
// interrupteur (contrairement à une balise <audio> classique, qui l'ignore déjà). Un visiteur qui ouvre
// un lien de pitch avec l'interrupteur activé n'entendrait donc rien et croirait le lecteur cassé.
// Technique connue et documentée (utilisée notamment par les librairies unmute-ios-audio et unmute) :
// faire jouer en boucle un très court son silencieux via <audio> force iOS à basculer tout l'audio de la
// page — Web Audio compris — sur le canal "média" plutôt que le canal "sonnerie", qui seul respecte
// l'interrupteur. Contournement non officiel (pas garanti par Apple), mais stable depuis plusieurs années.
// Le fichier est un WAV silencieux de 50ms encodé en base64, généré localement — aucune dépendance externe,
// compatible file://.
const SILENT_WAV_DATA_URI = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
let iosSilentUnlockDone = false;
function unlockIOSSilentSwitch() {
  if (iosSilentUnlockDone) return;
  iosSilentUnlockDone = true;
  try {
    const el = new Audio(SILENT_WAV_DATA_URI);
    el.loop = true;
    el.setAttribute('x-webkit-airplay', 'deny');
    el.play().catch(() => {});
  } catch (e) { /* best-effort : un échec ici ne doit jamais bloquer la lecture normale */ }
}
// Même endroit que ctx.resume() car les deux répondent au même besoin (débloquer l'audio suite à un
// geste utilisateur) — appeler les deux ensemble évite d'avoir à les dupliquer à chaque point d'appel.
function resumeAudioContext() {
  if (ctx.state === 'suspended') ctx.resume();
  unlockIOSSilentSwitch();
}

// Dupliqué à l'identique dans index.html et pack.html : chaque script a sa propre closure, pas d'accès
// croisé possible. Jamais bloquant, silencieux si Umami n'est pas chargé.
// Le contexte (quel AdReel ou quel Pack a généré l'événement) est déposé sur `window.__lpTrackContext`
// par la page hôte (index.html ou pack.html) dès qu'elle connaît son propre identifiant — permet de
// distinguer dans Umami "le lien envoyé au Studio X" plutôt qu'un compteur global indifférencié.
function trackPublicEvent(name, detail) {
  try {
    if (!window.umami) return;
    const ctx = window.__lpTrackContext || {};
    window.umami.track(name, Object.assign({}, detail, ctx.type ? { [ctx.type]: ctx.id } : {}));
  } catch (e) { /* jamais bloquant */ }
}

// Traductions de l'habillage généré par le moteur (statuts, boutons, libellés de mode...) — pas le
// Traductions de l'habillage généré par le moteur (statuts, boutons, libellés de mode...) — pas le
// contenu des morceaux eux-mêmes (titres, descriptions, labels de couches saisis par le compositeur).
// Vit dans layerpitch-i18n.js (zones "shared" + "player"), chargé avant ce script — édité via l'outil
// dédié, jamais à la main. Ce fichier n'a pas besoin de balayer le DOM après coup : le texte est inséré
// directement dans les gabarits au moment de leur construction, via t('clé').
//
// La langue n'est plus lue depuis localStorage ici : chaque page hôte (index.html, pack.html,
// layerpitch-backstage.html) la détermine elle-même selon son propre contexte (langue de l'AdReel,
// paramètre d'URL du pack, réglage du backstage) et l'impose via setLang() avant de construire quoi
// que ce soit. Évite qu'un visiteur voie une langue différente de celle choisie par le compositeur.
let CURRENT_LANG = 'fr';
function setLang(lang) { CURRENT_LANG = (lang === 'en') ? 'en' : 'fr'; }
function currentLang() { return CURRENT_LANG; }
// t('clé', {placeholder: valeur}) — remplace {placeholder} dans la chaîne traduite si fourni.
// Ordre de repli : zone player dans la langue courante -> zone shared dans la langue courante ->
// zone player en français (au cas où l'anglais ne serait pas encore traduit) -> zone shared en français
// -> la clé elle-même (filet de sécurité si layerpitch-i18n.js n'a pas encore chargé ou est incomplet).
function t(key, vars) {
  const I18N = window.LAYERPITCH_I18N || { fr: { shared: {}, player: {} }, en: { shared: {}, player: {} } };
  const dict = I18N[currentLang()] || I18N.fr;
  const dictFr = I18N.fr;
  let str = (dict.player && dict.player[key]) || (dict.shared && dict.shared[key])
    || (dictFr.player && dictFr.player[key]) || (dictFr.shared && dictFr.shared[key]) || key;
  if (vars) Object.keys(vars).forEach(k => { str = str.replace('{' + k + '}', vars[k]); });
  return str;
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}
// Déplie/replie la vue détaillée d'une piste en mesurant sa vraie hauteur en JS plutôt qu'en s'appuyant
// sur l'astuce CSS grid-template-rows 0fr/1fr, qui ne réduisait pas correctement à zéro dans certains
// navigateurs (résidu visible : la description "fuyait" même piste repliée).
function setDetailsExpanded(details, expanded) {
  if (!details) return;
  const inner = details.querySelector('.track-row-details-inner');
  if (expanded) {
    details.classList.add('expanded');
    details.style.maxHeight = (inner ? inner.scrollHeight : 0) + 'px';
  } else {
    details.classList.remove('expanded');
    details.style.maxHeight = '0px';
  }
}
function cumulativeProfiles(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Array.from({ length: n }, (_, j) => (j <= i ? 1 : 0)));
  return out;
}
function section(label, innerHTML) {
  const el = document.createElement('div');
  el.className = 'block';
  el.innerHTML = (label ? `<div class="section-label">${label}</div>` : '') + innerHTML;
  return el;
}
function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function linkify(s) { return escapeHtml(s).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>'); }

/* ---------------- État partagé entre toutes les pistes de la page (une seule instance par page chargée) ---------------- */
const trackCollapsers = {};
const trackStingerKillers = {};
let activeTrackId = null;

// Empêche l'écran de se verrouiller pendant qu'une piste joue (sinon le tél s'éteint "comme si de rien
// n'était" pendant une écoute) — best-effort, l'API n'existe pas partout, et le verrou se relâche de
// toute façon automatiquement si l'onglet passe en arrière-plan (voir la reprise après veille plus bas).
const playingTrackIds = new Set(); // pas activeTrackId : celui-ci n'est jamais effacé sur une simple pause manuelle
let wakeLock = null;
async function requestWakeLock() {
  if (!navigator.wakeLock || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
  catch (e) { /* refusé ou indisponible : tant pis, ce n'est qu'un confort */ }
}
function releaseWakeLockIfIdle() {
  if (wakeLock && playingTrackIds.size === 0) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
if (navigator.wakeLock) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && playingTrackIds.size > 0) requestWakeLock();
  });
}

function renderTracksBlock(container, tracks, packsByTrackId) {
  const el = section(t('musicSection'), '');
  container.appendChild(el);
  if (!tracks || tracks.length === 0) {
    el.innerHTML += `<div class="empty">${t('noTracksPublished')}</div>`;
    return;
  }

  tracks.forEach(track => {
    const packsForTrack = (packsByTrackId && packsByTrackId[track.id]) || [];
    const row = buildTrackRow(track, packsForTrack);
    el.appendChild(row);
    initTrackPlayer(track, row);
  });
}

function getModeLabel(mode) {
  const map = {
    static: t('modeStatic'),
    vertical: t('modeVertical'),
    'vertical-random': t('modeVerticalRandom'),
    sequential: t('modeSequential'),
    branching: t('modeBranching')
  };
  return map[mode] || mode;
}
const PLAYABLE_MODES = ['static', 'vertical', 'vertical-random', 'sequential'];

function layerHasSource(l) { return !!(l && (l.localFile || l.file)); }

function buildTrackRow(track, packsForTrack) {
  packsForTrack = packsForTrack || [];
  const supported = PLAYABLE_MODES.includes(track.mode);
  const isStatic = track.mode === 'static';
  const isVerticalRandom = track.mode === 'vertical-random';
  const isSequential = track.mode === 'sequential';
  const loops = !isStatic || !!track.loopable;
  // Même plafond que progressMaxSec() dans initTrackPlayer : vertical-random affiche la longueur du
  // cycle qui boucle, pas celle du fichier le plus long du pool (voir le commentaire détaillé là-bas).
  const displayMaxSec = (() => {
    if (!isVerticalRandom) return track.duration;
    const spb = 60 / (track.bpm || 120);
    const lIn = (track.loopInBeat || 0) * spb;
    const lOut = Math.max(lIn + spb, (track.loopOutBeat || (track.beatsPerBar || 4) * 4) * spb);
    return lOut || track.duration;
  })();
  const hasFiles = supported && (isVerticalRandom
    ? (track.fixedLayers || []).some(layerHasSource)
    : isSequential
    ? (track.segments || []).some(layerHasSource)
    : layerHasSource(track.layers[0]) && (isStatic || track.layers.every(layerHasSource)));

  const wrapper = document.createElement('div');
  wrapper.className = 'track-row-wrapper';

  let intensityBlockHtml = '';
  if (track.mode === 'vertical' && supported) {
    const n = track.layers.length;
    const chips = Array.from({ length: n }, (_, i) => {
      const customLabel = (track.layers[i] && track.layers[i].label) ? track.layers[i].label : '';
      const inner = customLabel
        ? `<span class="intensity-chip-num">${i + 1}</span>${escapeHtml(customLabel)}`
        : String(i + 1);
      return `<button type="button" class="intensity-chip${i === 0 ? ' active' : ''}" data-level="${i}">${inner}</button>`;
    }).join('');
    intensityBlockHtml = `
      <div class="track-intensity-block">
        <div class="track-intensity-label">${t('intensityLabel')}</div>
        <div class="intensity-picker" data-role="slider">${chips}</div>
      </div>
    `;
  }

  // Panneau "En cours" pour le vertical classique : un vumètre par couche, qui reflète en direct
  // son gain réel — visible pendant le fondu enchaîné quand l'intensité change (façon Wwise Voice Graph).
  let vertGraphHtml = '';
  if (track.mode === 'vertical' && supported) {
    vertGraphHtml = `
      <div class="voice-graph" data-role="vertGraph">
        <div class="voice-graph-label">${t('inProgressLabel')}</div>
        ${track.layers.map((l, i) => `
          <div class="voice-row">
            <span class="voice-row-label">${escapeHtml((l && l.label) || t('layerFallback', { n: i + 1 }))}</span>
            <span class="voice-meter-bar" data-role="vertMeter-${i}"><span class="voice-meter-bar-fill"></span></span>
            <div class="wwise-node-controls">
              <button type="button" class="voice-ctrl-btn" data-voice-action="solo" data-voice-key="layer-${i}" title="${t('soloTitle')}">S</button>
              <button type="button" class="voice-ctrl-btn" data-voice-action="mute" data-voice-key="layer-${i}" title="${t('muteTitle')}">M</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  let voiceGraphHtml = '';
  if (isVerticalRandom && supported) {
    const fixedNodes = (track.fixedLayers || []).map((f, fi) => `
      <div class="wwise-node wwise-node-voice" data-role="wwiseVoice-fixed-${fi}">
        <div class="wwise-node-top">
          <div class="wwise-node-label">${escapeHtml(f && f.label ? f.label : t('fixedLayerFallback', { n: fi + 1 }))}</div>
          <div class="wwise-node-controls">
            <button type="button" class="voice-ctrl-btn" data-voice-action="solo" data-voice-key="fixed-${fi}" title="${t('soloTitle')}">S</button>
            <button type="button" class="voice-ctrl-btn" data-voice-action="mute" data-voice-key="fixed-${fi}" title="${t('muteTitle')}">M</button>
          </div>
        </div>
        <span class="wwise-node-wave">
          <canvas class="wwise-wave-bg" data-role="voiceWaveBg-fixed-${fi}"></canvas>
          <canvas class="wwise-wave-fg" data-role="voiceWaveFg-fixed-${fi}"></canvas>
        </span>
      </div>
    `).join('');
    const groupNodes = (track.randomGroups || []).map((g, gi) => `
      <div class="wwise-node wwise-node-voice" data-role="wwiseVoice-group-${gi}">
        <div class="wwise-node-top">
          <div class="wwise-node-label" data-role="voiceCurrent-${gi}">—</div>
          <div class="wwise-node-controls">
            <button type="button" class="voice-ctrl-btn" data-voice-action="solo" data-voice-key="group-${gi}" title="${t('soloTitle')}">S</button>
            <button type="button" class="voice-ctrl-btn" data-voice-action="mute" data-voice-key="group-${gi}" title="${t('muteTitle')}">M</button>
          </div>
        </div>
        <span class="wwise-node-wave">
          <canvas class="wwise-wave-bg" data-role="voiceWaveBg-${gi}"></canvas>
          <canvas class="wwise-wave-fg" data-role="voiceWaveFg-${gi}"></canvas>
        </span>
      </div>
    `).join('');
    voiceGraphHtml = `
      <div class="voice-graph" data-role="voiceGraph">
        <div class="voice-graph-label">${t('inProgressLabel')}</div>
        <div class="wwise-graph" data-role="wwiseGraph">
          <svg class="wwise-graph-lines" data-role="wwiseLines"></svg>
          <div class="wwise-col wwise-col-source">
            <div class="wwise-node wwise-node-source" data-role="wwiseSource">${escapeHtml(track.title || t('trackFallback'))}</div>
          </div>
          <div class="wwise-col wwise-col-voices">
            ${fixedNodes}
            ${groupNodes}
          </div>
          <div class="wwise-col wwise-col-bus">
            <div class="wwise-node wwise-node-bus" data-role="wwiseBus">${t('outputNode')}</div>
          </div>
        </div>
        <button type="button" class="voice-refresh-btn" data-role="refreshPool">${t('refreshPool')}</button>
      </div>
    `;
  }

  let seqGraphHtml = '';
  if (isSequential && supported) {
    const hasIntro = layerHasSource(track.intro);
    const hasOutro = layerHasSource(track.outro);
    seqGraphHtml = `
      <div class="voice-graph" data-role="seqGraph">
        <div class="voice-graph-label">${t('inProgressLabel')}</div>
        <div class="seq-blocks" data-role="seqBlocks">
          ${hasIntro ? `<div class="seq-block" data-role="seqBlock-intro"><canvas class="seq-block-wave-bg" data-role="seqWaveBg-intro"></canvas><canvas class="seq-block-wave-fg" data-role="seqWaveFg-intro"></canvas><span class="seq-block-label">${t('introLabel')}</span></div>` : ''}
          <div class="seq-block" data-role="seqBlock-segment"><canvas class="seq-block-wave-bg" data-role="seqWaveBg-segment"></canvas><canvas class="seq-block-wave-fg" data-role="seqWaveFg-segment"></canvas><span class="seq-block-label">${t('segmentLabel')}</span></div>
          ${hasOutro ? `<div class="seq-block" data-role="seqBlock-outro"><canvas class="seq-block-wave-bg" data-role="seqWaveBg-outro"></canvas><canvas class="seq-block-wave-fg" data-role="seqWaveFg-outro"></canvas><span class="seq-block-label">${t('outroLabel')}</span></div>` : ''}
        </div>
        <div class="voice-row">
          <span class="voice-meter" data-role="seqMeter"></span>
          <span class="voice-row-current" data-role="seqCurrent">—</span>
        </div>
        <button type="button" class="voice-refresh-btn" data-role="goToEndBtn" disabled>${t('goToEndBtn')}</button>
      </div>
    `;
  }

  // Sélecteur de boucles : uniquement pour les pistes qui utilisent le moteur quantifié (seul moteur
  // qui connaît la notion de cycle et donc de "nombre de boucles"). Valeur par défaut = celle choisie
  // par le compositeur, modifiable ici par le visiteur — la piste applique le changement au vol.
  const useQuantizedLoopForUI = isVerticalRandom || (loops && track.loopEngine === 'quantized');
  let loopCountHtml = '';
  if (useQuantizedLoopForUI && supported) {
    const options = [null, 1, 2, 3, 5, 10];
    const current = track.maxLoops || null;
    loopCountHtml = `
      <div class="loop-count-block">
        <div class="loop-count-label">${t('loopCountLabel')}</div>
        <select data-role="loopCountSelect">
          ${options.map(n => `<option value="${n === null ? '' : n}"${current === n ? ' selected' : ''}>${n === null ? t('infiniteLoops') : n}</option>`).join('')}
        </select>
      </div>
    `;
  }

  wrapper.innerHTML = `
    <div class="track-row">
      <button class="play-btn" data-role="playBtn" disabled aria-label="${t('loadingAriaLabel')}">
        <svg data-role="playIcon" class="loading-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-dasharray="28 100"/></svg>
      </button>
      <div class="track-row-title" data-role="titleToggle">
        <span class="name">${escapeHtml(track.title)}</span>
        <span class="mode-tag">${getModeLabel(track.mode)}</span>
        ${supported ? `
          <span class="loop-icon" title="${loops ? 'Bouclable' : 'Ne boucle pas'}">
            ${loops
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M13 6l6 6-6 6"/></svg>'}
          </span>
        ` : ''}
      </div>
    </div>
    <div class="track-row-details" data-role="details">
     <div class="track-row-details-inner">
      <div class="track-desc">${linkify(track.description || '')}</div>
      ${packsForTrack && packsForTrack.length ? `<div class="pack-link">${packsForTrack.map(p => `<a href="./pack.html?id=${encodeURIComponent(p.id)}">${t('partOfCollection', { title: escapeHtml(p.title) })}</a>`).join('<br>')}</div>` : ''}
      ${!supported ? `<span class="placeholder-tag">Mode "${track.mode}" pas encore supporté</span>` :
        !hasFiles ? `<span class="placeholder-tag">Fichiers audio manquants</span>` : (
        isSequential ? `
          <div class="status" data-role="status">Chargement…</div>
          ${track.stingers && track.stingers.length ? `
            <div class="stingers" data-role="stingers">
              ${track.stingers.map((s, i) => `<button class="stinger-btn" data-stinger="${i}" disabled><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>${escapeHtml(s.label || ('Stinger ' + (i + 1)))}</button>`).join('')}
            </div>
          ` : ''}
        ` : `
        <div class="status" data-role="status">Chargement…</div>
        <div class="progress-wrap${isStatic ? ' waveform-mode' : ''}" data-role="progressWrap">
          ${isStatic ? `
            <canvas class="waveform-bg" data-role="waveformBg"></canvas>
            <canvas class="waveform-fg" data-role="waveformFg"></canvas>
          ` : `
            <div class="progress-track"></div>
            <div class="progress-fill" data-role="progressFill"></div>
            <div class="progress-head" data-role="progressHead"></div>
          `}
        </div>
        <div class="time-row"><span data-role="timeCurrent">0:00</span><span data-role="timeTotal">${formatTime(displayMaxSec)}</span></div>
        ${track.stingers && track.stingers.length ? `
          <div class="stingers" data-role="stingers">
            ${track.stingers.map((s, i) => `<button class="stinger-btn" data-stinger="${i}" disabled><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>${escapeHtml(s.label || ('Stinger ' + (i + 1)))}</button>`).join('')}
          </div>
        ` : ''}
      `)}
      ${intensityBlockHtml}
      ${loopCountHtml}
      ${voiceGraphHtml}
      ${vertGraphHtml}
      ${seqGraphHtml}
     </div>
    </div>
  `;

  wrapper.querySelector('[data-role="titleToggle"]').addEventListener('click', () => {
    const details = wrapper.querySelector('[data-role="details"]');
    setDetailsExpanded(details, !details.classList.contains('expanded'));
  });

  return wrapper;
}

function initTrackPlayer(track, wrapper) {
  const isStatic = track.mode === 'static';
  const isVerticalRandom = track.mode === 'vertical-random';
  const isSequential = track.mode === 'sequential';
  const supported = PLAYABLE_MODES.includes(track.mode);
  // Harmonisation des volumes : décision du compositeur (case à cocher dans le backstage), jamais
  // automatique — sinon un fichier qui sonne différemment de ce qu'il a exporté serait déroutant.
  // Le gain mesuré à la conversion reste stocké dans tous les cas ; ce n'est que son application à la
  // lecture qui dépend de ce réglage.
  function effGain(item) {
    return (track.normalizeVolume && item && item.gain) ? item.gain : 1;
  }
  // Solo/muet par voix (vertical et vertical-random) : plusieurs voix peuvent être soloées en même temps
  // (convention DAW classique) — dès qu'au moins une l'est, tout le reste se tait, quel que soit son
  // propre état muet. "Voix" = une couche (vertical), une couche fixe ou un groupe entier (vertical-random,
  // pas chaque alternative individuellement, puisqu'une seule alternative par groupe sonne à la fois).
  const mutedVoices = new Set();
  const soloedVoices = new Set();
  function voiceGain(key) {
    if (soloedVoices.size > 0) return soloedVoices.has(key) ? 1 : 0;
    return mutedVoices.has(key) ? 0 : 1;
  }
  // Recalcule en direct le gain de toutes les sources actuellement en train de sonner (génération en
  // cours et éventuelles queues encore audibles) — sans ça, un solo/muet ne prendrait effet qu'à la
  // prochaine génération programmée, avec un délai pouvant aller jusqu'à la longueur du cycle.
  function refreshVoiceGains() {
    const now = ctx.currentTime;
    const p = profiles[level] || profiles[0];
    activeGenSources.forEach(({ gain, voiceKey, baseGain }) => {
      if (!voiceKey || !gain) return;
      // Vertical classique : le gain dépend de l'intensité courante, qui peut avoir changé depuis que
      // cette génération a été programmée (via le curseur) — on le recalcule plutôt que de se fier à
      // une valeur figée, sinon un changement d'intensité récent serait ignoré par ce recalcul.
      let base = baseGain != null ? baseGain : 1;
      if (voiceKey.indexOf('layer-') === 0) {
        const i = parseInt(voiceKey.slice(6), 10);
        base = (p[i] || 0) * effGain(layersToLoad[i]);
      }
      const target = base * voiceGain(voiceKey);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(target, now + 0.15);
    });
    // Moteur simple (vertical sans moteur quantifié) : les gains vivent dans gains[], pas activeGenSources.
    if (!useQuantizedLoop && gains.length && playing) {
      gains.forEach((g, i) => {
        if (!g) return;
        const base = (p[i] || 0) * effGain(layersToLoad[i]);
        const target = base * voiceGain('layer-' + i);
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(target, now + 0.15);
      });
    }
  }
  const hasFiles = supported && (isVerticalRandom
    ? (track.fixedLayers || []).some(layerHasSource)
    : isSequential
    ? (track.segments || []).some(layerHasSource)
    : layerHasSource(track.layers[0]) && (isStatic || track.layers.every(layerHasSource)));
  if (!hasFiles) return;

  const layersToLoad = (isVerticalRandom || isSequential) ? [] : (isStatic ? [track.layers[0]] : track.layers);
  const profiles = (isVerticalRandom || isSequential) ? [] : (isStatic ? [[1]] : cumulativeProfiles(track.layers.length));
  const loops = !isStatic || !!track.loopable; // toujours vrai pour vertical-random (isStatic est faux)
  const useQuantizedLoop = !isSequential && (isVerticalRandom || (loops && track.loopEngine === 'quantized'));
  const stingerDefs = track.stingers ? track.stingers.filter(s => s.file || s.localFile) : [];

  // Paramètres du moteur quantifié (BPM/mesures + queue de fin superposée) — ignorés si useQuantizedLoop est faux
  const bpm = track.bpm || 120;
  const beatsPerBar = track.beatsPerBar || 4;
  const secondsPerBeat = 60 / bpm;
  const loopInSec = (track.loopInBeat || 0) * secondsPerBeat;
  const loopOutSec = Math.max(loopInSec + secondsPerBeat, (track.loopOutBeat || beatsPerBar * 4) * secondsPerBeat);
  const cycleLength = loopOutSec - loopInSec;
  // Pour vertical-random, track.duration reflète le fichier le PLUS LONG de tout le pool (couches fixes
  // + toutes les alternatives de tous les groupes), pas la longueur du cycle qui boucle réellement —
  // un seul alternative par groupe joue à la fois, souvent bien plus courte que la plus longue du pool.
  // Sans ce plafond, cliquer loin dans la barre programme un bufferOffset au-delà de la longueur réelle
  // des buffers en cours de lecture (silence, plus de boucle). Les autres modes gardent track.duration :
  // toutes leurs couches partagent la même durée par convention, donc pas le même risque.
  // Fonction plutôt que valeur figée : track.duration n'est connu avec certitude qu'une fois le
  // décodage terminé (voir plus bas), donc on le relit à chaque appel plutôt que de le geler trop tôt.
  function progressMaxSec() { return isVerticalRandom ? (loopOutSec || track.duration) : track.duration; }
  // StartTrackPoint : où démarre la toute première lecture (permet de sauter un silence en tête).
  // Ne s'applique qu'au moteur quantifié — le moteur simple garde son comportement natif inchangé.
  const startTrackSec = Math.min((track.startTrackBeat || 0) * secondsPerBeat, loopInSec);

  const playBtn = wrapper.querySelector('[data-role="playBtn"]');
  const playIcon = wrapper.querySelector('[data-role="playIcon"]');
  const details = wrapper.querySelector('[data-role="details"]');
  const statusEl = wrapper.querySelector('[data-role="status"]');
  const wrap = wrapper.querySelector('[data-role="progressWrap"]');
  const fill = wrapper.querySelector('[data-role="progressFill"]');
  const head = wrapper.querySelector('[data-role="progressHead"]');
  // Recale max-height si le contenu change de taille pendant que la piste est dépliée (ex. le statut
  // qui passe de "Chargement…" à "Prêt", ou une waveform qui apparaît) — sinon la hauteur mesurée au
  // moment du dépli deviendrait obsolète et couperait ou laisserait un vide sous le contenu.
  const detailsInnerEl = details.querySelector('.track-row-details-inner');
  if (detailsInnerEl && window.ResizeObserver) {
    new ResizeObserver(() => {
      if (details.classList.contains('expanded')) details.style.maxHeight = detailsInnerEl.scrollHeight + 'px';
    }).observe(detailsInnerEl);
  }
  // Waveform (mode statique uniquement — une seule couche jouée à la fois, donc "la" forme d'onde du
  // morceau a un sens ; ambigu pour vertical/vertical-random où plusieurs couches sonnent ensemble).
  const waveformBg = wrapper.querySelector('[data-role="waveformBg"]');
  const waveformFg = wrapper.querySelector('[data-role="waveformFg"]');
  let waveformPeaks = null;
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function computeWaveformPeaks(buffer, bucketCount) {
    const data = buffer.getChannelData(0); // un seul canal suffit pour une représentation visuelle
    const samplesPerBucket = Math.max(1, Math.floor(data.length / bucketCount));
    const peaks = new Array(bucketCount).fill(0);
    for (let i = 0; i < bucketCount; i++) {
      let max = 0;
      const start = i * samplesPerBucket;
      const end = Math.min(start + samplesPerBucket, data.length);
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return peaks;
  }
  function drawWaveformCanvas(canvas, peaks, color) {
    if (!canvas || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (w < 2 || h < 2) return; // pas encore mis en page (ex. onglet caché) : on retentera au prochain redraw
    canvas.width = w; canvas.height = h;
    const c2d = canvas.getContext('2d');
    c2d.clearRect(0, 0, w, h);
    c2d.fillStyle = color;
    const barCount = peaks.length;
    const slot = w / barCount;
    const barWidth = Math.max(1, slot - Math.max(1, Math.round(dpr)));
    const mid = h / 2;
    for (let i = 0; i < barCount; i++) {
      const amp = Math.max(0.04, peaks[i]); // hauteur minimale visible même sur un silence
      const barH = Math.max(2 * dpr, amp * h);
      c2d.fillRect(i * slot, mid - barH / 2, barWidth, barH);
    }
  }
  function redrawWaveforms() {
    drawWaveformCanvas(waveformBg, waveformPeaks, cssVar('--border', '#ccc'));
    drawWaveformCanvas(waveformFg, waveformPeaks, cssVar('--accent', '#c9713c'));
  }
  if (waveformBg && waveformFg) {
    // Redessine si le contraste renforcé change (couleurs différentes) ou si le conteneur change de taille
    // (redimensionnement de fenêtre, ou premier dépli depuis l'état replié).
    document.addEventListener('layerpitch-contrast-changed', redrawWaveforms);
    if (window.ResizeObserver) new ResizeObserver(redrawWaveforms).observe(waveformBg);
  }
  const timeCurrent = wrapper.querySelector('[data-role="timeCurrent"]');
  const timeTotal = wrapper.querySelector('[data-role="timeTotal"]');
  const notchDots = [...wrapper.querySelectorAll('.intensity-chip')];
  const stingerBtns = [...wrapper.querySelectorAll('.stinger-btn')];
  const loopCountSelect = wrapper.querySelector('[data-role="loopCountSelect"]');
  const voiceWaveFixed = (track.fixedLayers || []).map((f, fi) => ({
    bg: wrapper.querySelector(`[data-role="voiceWaveBg-fixed-${fi}"]`),
    fg: wrapper.querySelector(`[data-role="voiceWaveFg-fixed-${fi}"]`)
  }));
  const voiceWaveGroups = (track.randomGroups || []).map((g, gi) => ({
    bg: wrapper.querySelector(`[data-role="voiceWaveBg-${gi}"]`),
    fg: wrapper.querySelector(`[data-role="voiceWaveFg-${gi}"]`)
  }));
  const voiceCurrents = (track.randomGroups || []).map((g, gi) => wrapper.querySelector(`[data-role="voiceCurrent-${gi}"]`));
  // Dessine la waveform d'une voix vertical-random (couche fixe ou alternative piochée) — même principe
  // fond/avant-plan que la waveform du mode statique et les blocs du mode séquentiel.
  function drawVoiceWave(els, buffer) {
    if (!els || !els.bg || !els.fg || !buffer) return;
    const peaks = computeWaveformPeaks(buffer, 60);
    drawWaveformCanvas(els.bg, peaks, cssVar('--border', '#ccc'));
    drawWaveformCanvas(els.fg, peaks, cssVar('--accent', '#c9713c'));
  }
  // Graphe de nœuds façon Wwise (Voice Graph) pour vertical-random : source -> une voix par couche
  // fixe/groupe -> bus de sortie, reliés par des connecteurs courbes dessinés en SVG. Le nombre de voix
  // est fixe pour un morceau donné (seul le libellé/l'état de chaque voix change à chaque tirage), donc
  // les connecteurs ne sont redessinés qu'au premier rendu et au redimensionnement, pas à chaque tirage.
  const wwiseGraphEl = wrapper.querySelector('[data-role="wwiseGraph"]');
  const wwiseLinesEl = wrapper.querySelector('[data-role="wwiseLines"]');
  const wwiseSourceEl = wrapper.querySelector('[data-role="wwiseSource"]');
  const wwiseBusEl = wrapper.querySelector('[data-role="wwiseBus"]');
  const wwiseVoiceEls = [
    ...(track.fixedLayers || []).map((f, fi) => wrapper.querySelector(`[data-role="wwiseVoice-fixed-${fi}"]`)),
    ...(track.randomGroups || []).map((g, gi) => wrapper.querySelector(`[data-role="wwiseVoice-group-${gi}"]`))
  ];
  // Référence directe par groupe (pas seulement dans la liste à plat ci-dessus) pour pouvoir cacher/montrer
  // une voix précise quand son tirage tombe sur un slot silencieux — voir scheduleVoiceGraphUpdate.
  const wwiseGroupVoiceEls = (track.randomGroups || []).map((g, gi) => wrapper.querySelector(`[data-role="wwiseVoice-group-${gi}"]`));
  function drawWwiseLines() {
    if (!wwiseGraphEl || !wwiseLinesEl || !wwiseSourceEl || !wwiseBusEl) return;
    const rect = wwiseGraphEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    wwiseLinesEl.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    wwiseLinesEl.innerHTML = '';
    const srcRect = wwiseSourceEl.getBoundingClientRect();
    const busRect = wwiseBusEl.getBoundingClientRect();
    const srcPoint = { x: srcRect.right - rect.left, y: srcRect.top + srcRect.height / 2 - rect.top };
    const busPoint = { x: busRect.left - rect.left, y: busRect.top + busRect.height / 2 - rect.top };
    wwiseVoiceEls.forEach(voiceEl => {
      if (!voiceEl || voiceEl.style.display === 'none') return; // voix actuellement silencieuse : pas de connecteur vers du vide
      const vRect = voiceEl.getBoundingClientRect();
      const vLeft = { x: vRect.left - rect.left, y: vRect.top + vRect.height / 2 - rect.top };
      const vRight = { x: vRect.right - rect.left, y: vRect.top + vRect.height / 2 - rect.top };
      const mid1 = (srcPoint.x + vLeft.x) / 2;
      const path1 = document.createElementNS(svgNS, 'path');
      path1.setAttribute('d', `M ${srcPoint.x} ${srcPoint.y} C ${mid1} ${srcPoint.y}, ${mid1} ${vLeft.y}, ${vLeft.x} ${vLeft.y}`);
      path1.setAttribute('class', 'wwise-line');
      wwiseLinesEl.appendChild(path1);
      const mid2 = (vRight.x + busPoint.x) / 2;
      const path2 = document.createElementNS(svgNS, 'path');
      path2.setAttribute('d', `M ${vRight.x} ${vRight.y} C ${mid2} ${vRight.y}, ${mid2} ${busPoint.y}, ${busPoint.x} ${busPoint.y}`);
      path2.setAttribute('class', 'wwise-line');
      wwiseLinesEl.appendChild(path2);
    });
  }
  if (wwiseGraphEl) {
    requestAnimationFrame(drawWwiseLines); // laisse le temps à un premier passage de mise en page
    if (window.ResizeObserver) new ResizeObserver(drawWwiseLines).observe(wwiseGraphEl);
  }
  // Vumètres du mode vertical classique — remplissage en direct sur le vrai gain de chaque couche,
  // visible pendant le fondu enchaîné quand l'intensité change (voir tick() plus bas).
  const vertMeterFills = (track.mode === 'vertical' ? track.layers : []).map((l, i) => wrapper.querySelector(`[data-role="vertMeter-${i}"] .voice-meter-bar-fill`));
  const seqMeterEl = wrapper.querySelector('[data-role="seqMeter"]');
  const seqCurrentEl = wrapper.querySelector('[data-role="seqCurrent"]');
  const goToEndBtn = wrapper.querySelector('[data-role="goToEndBtn"]');

  let buffers = [], sources = [], gains = []; // moteur simple
  let activeGenSources = []; // moteur quantifié : [{src, gain}], toutes générations (dont queues) confondues
  let currentGainNodes = []; // moteur quantifié : gains de la génération la plus récente, par couche (contrôle d'intensité en direct)
  let schedulerTimer = null;
  let voiceGraphTimeouts = [];
  let nextGenStartCtxTime = 0, nextGenBufferOffset = 0;
  // Historique des générations programmées : { ctxStartTime, bufferOffset }. Sert à retrouver la position
  // RÉELLEMENT audible à un instant donné (voir currentPlaybackOffset ci-dessous) — pas simplement "la dernière
  // programmée", qui à cause du lookahead scheduler (jusqu'à 1s d'avance) peut encore être dans le futur au
  // moment où on la lit, ce qui donnait une tête de lecture visuellement en avance sur le son.
  let scheduledGens = [];
  function currentPlaybackOffset() {
    let chosen = null;
    for (const g of scheduledGens) {
      if (g.ctxStartTime <= ctx.currentTime && (!chosen || g.ctxStartTime > chosen.ctxStartTime)) chosen = g;
    }
    if (!chosen) return 0;
    return Math.min(chosen.bufferOffset + (ctx.currentTime - chosen.ctxStartTime), progressMaxSec());
  }
  // Nombre de boucles (moteur quantifié) : loopsPlayed compte les passages programmés par le scheduler
  // récurrent (pas le tout premier, déclenché directement par playQuantized). Une fois track.maxLoops
  // atteint (si non nul), on arrête de programmer de nouvelles générations et on laisse la dernière
  // en cours filer seule jusqu'à sa fin naturelle (l'outro = la queue déjà présente dans le fichier).
  let loopsPlayed = 0;
  let lastGenSources = [];
  let finalGenerationMarkerSrc = null;

  // Spécifique au mode vertical-random
  let fixedBuffers = []; // une entrée par couche fixe déclarée (toutes jouent systématiquement, à chaque cycle)
  let rawFixedLayers = []; // couches fixes réellement chargées (avec fichier), même indexation que fixedBuffers — sert à retrouver le bon gain de correction par index dans scheduleGeneration
  let groupBuffers = [];    // groupBuffers[g] = [buffer, buffer, ...] pour chaque alternative jouable du groupe g
  let lastPickedIndex = []; // lastPickedIndex[g] = index de la dernière alternative tirée pour le groupe g (-1 si aucune encore)
  function pickAlternativeIndex(g) {
    const group = (track.randomGroups || [])[g];
    const bufs = groupBuffers[g] || [];
    const n = bufs.length;
    if (n === 0) return -1;
    let idx = Math.floor(Math.random() * n);
    if (group && group.avoidImmediateRepeat && n > 1) {
      while (idx === lastPickedIndex[g]) idx = Math.floor(Math.random() * n);
    }
    lastPickedIndex[g] = idx;
    return idx;
  }

  let stingerBuffers = [];
  let activeStingerSources = [];

  // Spécifique au mode séquentiel
  let introBuffer = null, outroBuffer = null;
  let segmentBuffers = []; // aligné sur track.segments
  let lastSegmentIndex = -1;
  let seqSchedulerTimer = null;
  let seqNextStartCtxTime = 0;
  let seqActiveSources = []; // {src, gain} toutes générations confondues (dont queues en train de finir)
  let seqLastGenSources = [];
  let seqFinalMarkerSrc = null;
  let seqTimeouts = [];
  let goToEndRequested = false;
  function blockSeconds(bars) { return (bars || beatsPerBar) * beatsPerBar * secondsPerBeat; }
  function pickSegmentIndex() {
    const validIdxs = segmentBuffers.map((b, i) => b ? i : -1).filter(i => i >= 0);
    if (validIdxs.length === 0) return -1;
    let idx = validIdxs[Math.floor(Math.random() * validIdxs.length)];
    if (track.avoidImmediateRepeat && validIdxs.length > 1) {
      while (idx === lastSegmentIndex) idx = validIdxs[Math.floor(Math.random() * validIdxs.length)];
    }
    lastSegmentIndex = idx;
    return idx;
  }
  // Visualisation en blocs (intro / segment en cours / outro), qui se remplissent au rythme de la lecture —
  // demande directe d'un retour compositeur : "montrer un bloc pour le cue de départ qui se remplit en jouant,
  // puis un bloc pour la boucle tirée au sort, puis un bloc pour le cue de fin".
  const seqBlockEls = {
    intro: wrapper.querySelector('[data-role="seqBlock-intro"]'),
    segment: wrapper.querySelector('[data-role="seqBlock-segment"]'),
    outro: wrapper.querySelector('[data-role="seqBlock-outro"]')
  };
  // Chaque bloc affiche la vraie waveform du fichier qui y joue (pas un simple aplat de couleur) — pour
  // l'intro/l'outro le buffer est fixe, pour "segment" il change à chaque tirage et est donc recalculé
  // à chaque nouvelle activation. Même principe fond/avant-plan que la waveform du mode statique.
  const seqWaveEls = {
    intro: { bg: wrapper.querySelector('[data-role="seqWaveBg-intro"]'), fg: wrapper.querySelector('[data-role="seqWaveFg-intro"]') },
    segment: { bg: wrapper.querySelector('[data-role="seqWaveBg-segment"]'), fg: wrapper.querySelector('[data-role="seqWaveFg-segment"]') },
    outro: { bg: wrapper.querySelector('[data-role="seqWaveBg-outro"]'), fg: wrapper.querySelector('[data-role="seqWaveFg-outro"]') }
  };
  function drawSeqBlockWave(kind, buffer) {
    const els = seqWaveEls[kind];
    if (!els || !els.bg || !els.fg || !buffer) return;
    const peaks = computeWaveformPeaks(buffer, 50); // moins de barres que la waveform statique : blocs plus petits
    drawWaveformCanvas(els.bg, peaks, cssVar('--border', '#ccc'));
    drawWaveformCanvas(els.fg, peaks, cssVar('--accent', '#c9713c'));
  }
  function activateSeqStage(kind, durationSec, buffer) {
    const order = ['intro', 'segment', 'outro'];
    const idx = order.indexOf(kind);
    // Tout ce qui précède ce stade (hors "segment", qui se remplit à nouveau à chaque tirage plutôt que
    // de passer "fait") est figé plein — reflète la lecture qui vient réellement de passer ce point.
    order.forEach((k, i) => {
      if (i >= idx || k === 'segment') return;
      const block = seqBlockEls[k], els = seqWaveEls[k];
      if (!block) return;
      block.classList.remove('active'); block.classList.add('done');
      if (els && els.fg) { els.fg.style.transition = 'none'; els.fg.style.clipPath = 'inset(0 0% 0 0)'; }
    });
    const block = seqBlockEls[kind], els = seqWaveEls[kind];
    if (block) {
      block.classList.remove('done'); block.classList.add('active');
      if (buffer) drawSeqBlockWave(kind, buffer);
      if (els && els.fg) {
        els.fg.style.transition = 'none'; els.fg.style.clipPath = 'inset(0 100% 0 0)';
        void els.fg.offsetWidth; // force le reflow avant de relancer la transition, sinon le navigateur la fusionne avec le reset ci-dessus
        if (durationSec > 0) { els.fg.style.transition = `clip-path ${durationSec}s linear`; els.fg.style.clipPath = 'inset(0 0% 0 0)'; }
      }
    }
    // Le passage à l'outro clôt définitivement le stade "segment" (plus de nouveau tirage à suivre).
    if (kind === 'outro' && seqBlockEls.segment && seqWaveEls.segment.fg) {
      seqBlockEls.segment.classList.remove('active'); seqBlockEls.segment.classList.add('done');
      seqWaveEls.segment.fg.style.transition = 'none'; seqWaveEls.segment.fg.style.clipPath = 'inset(0 0% 0 0)';
    }
  }
  function resetSeqStages() {
    Object.keys(seqBlockEls).forEach(k => {
      const block = seqBlockEls[k], els = seqWaveEls[k];
      if (block) block.classList.remove('active', 'done');
      if (els && els.fg) { els.fg.style.transition = 'none'; els.fg.style.clipPath = 'inset(0 100% 0 0)'; }
    });
  }
  function scheduleSeqLabelUpdate(ctxStartTime, label, kind, fillDurationSec, buffer) {
    const delayMs = Math.max(0, (ctxStartTime - ctx.currentTime) * 1000);
    const id = setTimeout(() => {
      pulseMeter(seqMeterEl);
      if (seqCurrentEl) seqCurrentEl.textContent = label;
      if (kind) activateSeqStage(kind, fillDurationSec, buffer);
    }, delayMs);
    seqTimeouts.push(id);
  }
  function scheduleSeqGeneration(ctxStartTime, buffer, label, kind, fillDurationSec, gainValue) {
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainValue != null ? gainValue : 1, ctxStartTime);
    src.connect(g); g.connect(ctx.destination);
    src.start(ctxStartTime, 0);
    seqActiveSources.push({ src, gain: g });
    seqLastGenSources = [src];
    // Sans durée explicite (cas de l'outro, qui ne programme rien après elle) : on anime le remplissage
    // sur la durée réelle du fichier décodé, seule longueur connue dans ce cas.
    scheduleSeqLabelUpdate(ctxStartTime, label, kind, (fillDurationSec != null) ? fillDurationSec : buffer.duration, buffer);
  }
  // Détermine le prochain bloc à programmer : soit l'outro (si "Aller vers la fin" a été demandé et
  // qu'une outro existe), soit rien du tout (demande faite mais pas d'outro : on laisse filer), soit
  // un segment tiré au sort. `terminal: true` signifie "rien à programmer après ce bloc".
  function decideNextSeqBlock() {
    if (goToEndRequested) {
      goToEndRequested = false;
      if (outroBuffer) return { buffer: outroBuffer, label: (track.outro && track.outro.label) || 'Outro', durationSec: null, terminal: true, kind: 'outro', gain: effGain(track.outro) };
      return null;
    }
    const idx = pickSegmentIndex();
    if (idx < 0) return null;
    const seg = track.segments[idx];
    return { buffer: segmentBuffers[idx], label: (seg && seg.label) || ('Segment ' + (idx + 1)), durationSec: blockSeconds(seg && seg.bars), terminal: false, kind: 'segment', gain: effGain(seg) };
  }
  function armSeqFinalEnd() {
    const marker = seqLastGenSources[0];
    if (!marker) return;
    seqFinalMarkerSrc = marker;
    marker.onended = () => {
      if (seqFinalMarkerSrc !== marker) return; // piste arrêtée/relancée entretemps : on ignore
      seqActiveSources = [];
      playing = false;
      playingTrackIds.delete(track.id); releaseWakeLockIfIdle();
      setStoppedUI();
      if (goToEndBtn) { goToEndBtn.disabled = true; goToEndBtn.textContent = t('goToEndBtn'); }
      if (activeTrackId === track.id) activeTrackId = null;
    };
  }
  function seqSchedulerTick() {
    const lookahead = 1.0;
    while (seqNextStartCtxTime < ctx.currentTime + lookahead) {
      const next = decideNextSeqBlock();
      if (!next) {
        clearInterval(seqSchedulerTimer); seqSchedulerTimer = null;
        armSeqFinalEnd();
        return;
      }
      scheduleSeqGeneration(seqNextStartCtxTime, next.buffer, next.label, next.kind, next.terminal ? null : next.durationSec, next.gain);
      if (next.terminal) {
        clearInterval(seqSchedulerTimer); seqSchedulerTimer = null;
        armSeqFinalEnd();
        return;
      }
      seqNextStartCtxTime += next.durationSec;
    }
  }
  function stopSequential() {
    seqFinalMarkerSrc = null;
    if (seqSchedulerTimer) { clearInterval(seqSchedulerTimer); seqSchedulerTimer = null; }
    seqActiveSources.forEach(({ src }) => { try { src.stop(); } catch(e){} });
    seqActiveSources = [];
    seqTimeouts.forEach(id => clearTimeout(id));
    seqTimeouts = [];
    goToEndRequested = false;
    if (seqMeterEl) seqMeterEl.classList.remove('pulse');
    if (seqCurrentEl) seqCurrentEl.textContent = '—';
    if (goToEndBtn) { goToEndBtn.disabled = true; goToEndBtn.textContent = t('goToEndBtn'); }
    resetSeqStages();
  }
  function playSequential(isContinuation) {
    stopSequential();
    const now = ctx.currentTime;
    let firstBuffer, firstLabel, firstDurationSec, firstKind, firstGain;
    if (!isContinuation && introBuffer) {
      firstBuffer = introBuffer; firstLabel = (track.intro && track.intro.label) || 'Intro'; firstDurationSec = blockSeconds(track.intro && track.intro.bars); firstKind = 'intro'; firstGain = effGain(track.intro);
    } else {
      const idx = pickSegmentIndex();
      if (idx < 0) { if (statusEl) statusEl.textContent = t('noSegmentAvailable'); return; }
      const seg = track.segments[idx];
      firstBuffer = segmentBuffers[idx]; firstLabel = (seg && seg.label) || ('Segment ' + (idx + 1)); firstDurationSec = blockSeconds(seg && seg.bars); firstKind = 'segment'; firstGain = effGain(seg);
    }
    scheduleSeqGeneration(now, firstBuffer, firstLabel, firstKind, firstDurationSec, firstGain);
    seqNextStartCtxTime = now + firstDurationSec;
    seqSchedulerTimer = setInterval(seqSchedulerTick, 200);
    if (goToEndBtn) goToEndBtn.disabled = false;
  }
  let level = 0, playing = false, startedAt = 0, offsetAt = (useQuantizedLoop ? startTrackSec : 0), rafId = null, ready = false;
  let isDraggingSeek = false; // vrai pendant qu'on glisse sur la barre de lecture — tick() ne doit pas écraser la position affichée pendant ce temps

  const PLAY_SVG = '<path d="M8 5v14l11-7z"/>';
  const PAUSE_SVG = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
  // En cas d'échec de chargement : arrête l'icône qui tourne (elle donnerait l'impression que ça continue
  // de charger indéfiniment) et affiche un repère visuel statique d'erreur, cohérent avec le texte de
  // statut déjà présent dans le panneau déplié.
  function setLoadErrorIcon() {
    playIcon.classList.remove('loading-icon');
    playIcon.classList.add('error-icon');
    playIcon.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v6"/><circle cx="12" cy="16.7" r="0.9" fill="currentColor" stroke="none"/>';
    playBtn.setAttribute('aria-label', t('loadErrorAriaLabel'));
  }

  function updateStingerAvailability() {
    const expanded = details.classList.contains('expanded');
    setStingerButtonsEnabled(expanded && ready);
  }

  function setStingerButtonsEnabled(enabled) {
    stingerBtns.forEach(b => { b.disabled = !enabled; });
  }
  function killStingers() {
    activeStingerSources.forEach(s => { try { s.stop(); } catch(e){} });
    activeStingerSources = [];
  }
  trackCollapsers[track.id] = () => { setDetailsExpanded(details, false); updateStingerAvailability(); };
  trackStingerKillers[track.id] = killStingers;

  function updateProgressAt(elapsed) {
    if (!wrap) return;
    const pct = (elapsed / progressMaxSec()) * 100;
    if (fill) fill.style.width = pct + '%';
    if (head) head.style.left = pct + '%';
    if (waveformFg) waveformFg.style.clipPath = `inset(0 ${Math.max(0, 100 - pct)}% 0 0)`;
    timeCurrent.textContent = formatTime(elapsed);
  }
  function computeElapsed() {
    return useQuantizedLoop
      ? currentPlaybackOffset()
      : (loops ? (ctx.currentTime - startedAt) % track.duration : Math.min(ctx.currentTime - startedAt, track.duration));
  }
  function tick() {
    if (!playing || isSequential) return;
    const elapsed = computeElapsed();
    if (isDraggingSeek) { rafId = requestAnimationFrame(tick); return; } // laisse la position glissée visible, ne pas l'écraser
    updateProgressAt(elapsed);
    if (vertMeterFills.length) {
      const gainArr = useQuantizedLoop ? currentGainNodes : gains;
      vertMeterFills.forEach((fillEl, i) => {
        if (!fillEl) return;
        const g = gainArr[i];
        const v = g ? Math.min(1, Math.max(0, g.gain.value)) : 0;
        fillEl.style.width = Math.round(v * 100) + '%';
      });
    }
    if (isVerticalRandom) {
      // Toutes les voix redémarrent ensemble à chaque cycle (même scheduler partagé) : une seule
      // fraction de progression suffit pour synchroniser le recouvrement de toutes les waveforms.
      const frac = cycleLength > 0 ? Math.min(1, Math.max(0, (elapsed - loopInSec) / cycleLength)) : 0;
      const clip = `inset(0 ${(1 - frac) * 100}% 0 0)`;
      voiceWaveFixed.forEach(els => { if (els && els.fg) els.fg.style.clipPath = clip; });
      voiceWaveGroups.forEach(els => { if (els && els.fg) els.fg.style.clipPath = clip; });
    }
    rafId = requestAnimationFrame(tick);
  }
  function setStoppedUI() {
    playIcon.innerHTML = PLAY_SVG;
    if (statusEl) statusEl.textContent = t('pausedStatus');
  }

  /* ---- Moteur simple (bouclage natif, comportement existant inchangé) ---- */
  function stopSimple(keepPosition) {
    if (loops && keepPosition !== false) {
      offsetAt = (ctx.currentTime - startedAt) % track.duration;
    }
    sources.forEach(s => { if (s) { try { s.stop(); } catch(e){} } });
    sources = []; gains = [];
  }
  function playSimple() {
    startedAt = ctx.currentTime - offsetAt;
    const p = profiles[level] || profiles[0];
    for (let i = 0; i < buffers.length; i++) {
      const src = ctx.createBufferSource();
      src.buffer = buffers[i];
      if (loops) { src.loop = true; src.loopStart = 0; src.loopEnd = track.duration; }
      const g = ctx.createGain();
      g.gain.setValueAtTime((p[i] || 0) * effGain(layersToLoad[i]) * voiceGain('layer-' + i), ctx.currentTime);
      src.connect(g); g.connect(ctx.destination);
      src.start(0, offsetAt % track.duration);
      sources[i] = src; gains[i] = g;
      if (isStatic && !loops) {
        const layerIndex = i;
        src.onended = () => {
          // Si cette source a depuis été remplacée ou arrêtée manuellement (seek, stop, changement de piste),
          // sources[layerIndex] ne pointe plus vers elle -> ce n'est pas une vraie fin naturelle, on ignore.
          if (sources[layerIndex] !== src) return;
          naturalEnd();
        };
      }
    }
  }

  function pulseMeter(el) {
    if (!el) return;
    el.classList.remove('pulse');
    void el.offsetWidth; // force le reflow pour pouvoir rejouer l'animation même si elle est déjà active
    el.classList.add('pulse');
  }
  function scheduleVoiceGraphUpdate(ctxStartTime, groupPicks) {
    const delayMs = Math.max(0, (ctxStartTime - ctx.currentTime) * 1000);
    const timeoutId = setTimeout(() => {
      let topologyChanged = false;
      groupPicks.forEach(({ gi, label, silent, buf }) => {
        if (voiceCurrents[gi]) voiceCurrents[gi].textContent = label;
        const nodeEl = wwiseGroupVoiceEls[gi];
        if (nodeEl) {
          const wasHidden = nodeEl.style.display === 'none';
          nodeEl.style.display = silent ? 'none' : '';
          if (wasHidden !== !!silent) topologyChanged = true;
        }
        if (!silent && buf) {
          drawVoiceWave(voiceWaveGroups[gi], buf);
          const fg = voiceWaveGroups[gi] && voiceWaveGroups[gi].fg;
          if (fg) { fg.style.transition = 'none'; fg.style.clipPath = 'inset(0 100% 0 0)'; }
        }
      });
      if (topologyChanged) drawWwiseLines();
    }, delayMs);
    voiceGraphTimeouts.push(timeoutId);
  }

  /* ---- Moteur quantifié / vertical-random (BPM + mesures, retrigger avec queue de fin superposée) ---- */
  function scheduleGeneration(ctxStartTime, bufferOffset, reroll) {
    const thisGenSources = [];
    if (isVerticalRandom) {
      fixedBuffers.forEach((buf, fi) => {
        if (!buf) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        const key = 'fixed-' + fi;
        const base = effGain(rawFixedLayers[fi]);
        g.gain.setValueAtTime(base * voiceGain(key), ctxStartTime);
        src.connect(g); g.connect(ctx.destination);
        src.start(ctxStartTime, bufferOffset);
        activeGenSources.push({ src, gain: g, voiceKey: key, baseGain: base });
        thisGenSources.push(src);
      });
      const groupPicks = [];
      (track.randomGroups || []).forEach((group, gi) => {
        const idx = (reroll === false && lastPickedIndex[gi] !== undefined && lastPickedIndex[gi] !== -1)
          ? lastPickedIndex[gi]
          : pickAlternativeIndex(gi);
        let label = '—';
        let silent = true;
        let pickedBuf = null;
        if (idx >= 0) {
          const alt = (group.alternatives || [])[idx];
          const buf = (groupBuffers[gi] || [])[idx];
          silent = !buf;
          pickedBuf = buf;
          label = buf ? ((alt && alt.label) ? alt.label : t('altFallback', { n: idx + 1 })) : t('silenceLabel');
          if (buf) {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const g = ctx.createGain();
            const key = 'group-' + gi;
            const base = effGain(alt);
            g.gain.setValueAtTime(base * voiceGain(key), ctxStartTime);
            src.connect(g); g.connect(ctx.destination);
            src.start(ctxStartTime, bufferOffset);
            activeGenSources.push({ src, gain: g, voiceKey: key, baseGain: base });
            thisGenSources.push(src);
          }
        }
        groupPicks.push({ gi, label, silent, buf: pickedBuf });
      });
      scheduleVoiceGraphUpdate(ctxStartTime, groupPicks);
    } else {
      const p = profiles[level] || profiles[0];
      const gensThisRound = [];
      for (let i = 0; i < buffers.length; i++) {
        if (!buffers[i]) continue;
        const src = ctx.createBufferSource();
        src.buffer = buffers[i];
        const g = ctx.createGain();
        const key = 'layer-' + i;
        const base = (p[i] || 0) * effGain(layersToLoad[i]);
        g.gain.setValueAtTime(base * voiceGain(key), ctxStartTime);
        src.connect(g); g.connect(ctx.destination);
        src.start(ctxStartTime, bufferOffset);
        activeGenSources.push({ src, gain: g, voiceKey: key, baseGain: base });
        thisGenSources.push(src);
        gensThisRound[i] = g;
      }
      currentGainNodes = gensThisRound;
    }
    lastGenSources = thisGenSources;
    scheduledGens.push({ ctxStartTime, bufferOffset });
    const cutoff = ctx.currentTime - Math.max(cycleLength, 4) * 2;
    if (scheduledGens.length > 6) scheduledGens = scheduledGens.filter(g => g.ctxStartTime >= cutoff);
  }
  function schedulerTick() {
    const lookahead = 1.0;
    while (nextGenStartCtxTime < ctx.currentTime + lookahead) {
      if (track.maxLoops && loopsPlayed >= track.maxLoops) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
        armFinalGenerationEnd();
        return;
      }
      scheduleGeneration(nextGenStartCtxTime, nextGenBufferOffset, true);
      loopsPlayed++;
      nextGenStartCtxTime += cycleLength;
      nextGenBufferOffset = loopInSec;
    }
  }
  // Une fois la limite de boucles atteinte : on n'interrompt pas la génération en cours (qui contient
  // la queue déjà présente dans le fichier après le point de sortie) — elle continue de jouer seule,
  // sans rien programmer par-dessus. C'est ça, l'outro : pas un fichier séparé, juste l'absence de relance.
  function armFinalGenerationEnd() {
    const marker = lastGenSources[0];
    if (!marker) return;
    finalGenerationMarkerSrc = marker;
    marker.onended = () => {
      if (finalGenerationMarkerSrc !== marker) return; // piste arrêtée/relancée entretemps : on ignore
      activeGenSources = [];
      playing = false;
      playingTrackIds.delete(track.id); releaseWakeLockIfIdle();
      cancelAnimationFrame(rafId);
      offsetAt = startTrackSec;
      updateProgressAt(offsetAt);
      setStoppedUI();
      if (activeTrackId === track.id) activeTrackId = null;
    };
  }
  function stopQuantized() {
    finalGenerationMarkerSrc = null;
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    activeGenSources.forEach(({ src }) => { try { src.stop(); } catch(e){} });
    activeGenSources = [];
    voiceGraphTimeouts.forEach(id => clearTimeout(id));
    voiceGraphTimeouts = [];
    if (isVerticalRandom) {
      voiceWaveFixed.forEach(els => { if (els && els.fg) { els.fg.style.transition = 'none'; els.fg.style.clipPath = 'inset(0 100% 0 0)'; } });
      voiceWaveGroups.forEach(els => { if (els && els.fg) { els.fg.style.transition = 'none'; els.fg.style.clipPath = 'inset(0 100% 0 0)'; } });
      voiceCurrents.forEach(el => { if (el) el.textContent = '—'; });
      let anyWasHidden = false;
      wwiseGroupVoiceEls.forEach(el => { if (el && el.style.display === 'none') { anyWasHidden = true; el.style.display = ''; } });
      if (anyWasHidden) drawWwiseLines();
    }
  }
  function playQuantized(fromOffsetSec, reroll) {
    stopQuantized();
    const now = ctx.currentTime;
    scheduleGeneration(now, fromOffsetSec, reroll);
    let timeUntilNext;
    if (fromOffsetSec < loopInSec) {
      timeUntilNext = loopOutSec - fromOffsetSec;
    } else {
      const positionInLoop = (fromOffsetSec - loopInSec) % cycleLength;
      timeUntilNext = cycleLength - positionInLoop;
    }
    nextGenStartCtxTime = now + Math.max(0.02, timeUntilNext);
    nextGenBufferOffset = loopInSec;
    schedulerTimer = setInterval(schedulerTick, 200);
  }

  function stopAllSources(keepPosition) {
    playing = false;
    playingTrackIds.delete(track.id); releaseWakeLockIfIdle();
    if (isSequential) {
      stopSequential();
    } else if (useQuantizedLoop) {
      if (keepPosition !== false) {
        offsetAt = currentPlaybackOffset();
      }
      stopQuantized();
    } else {
      stopSimple(keepPosition);
    }
    cancelAnimationFrame(rafId);
    vertMeterFills.forEach(el => { if (el) { el.style.transition = 'none'; el.style.width = '0%'; } });
    setStoppedUI();
  }
  function naturalEnd() {
    playing = false;
    playingTrackIds.delete(track.id); releaseWakeLockIfIdle();
    cancelAnimationFrame(rafId);
    offsetAt = 0;
    updateProgressAt(0);
    setStoppedUI();
    if (activeTrackId === track.id) activeTrackId = null;
  }
  function playThisTrack(reroll, isContinuation) {
    if (activeTrackId && activeTrackId !== track.id) {
      document.dispatchEvent(new CustomEvent('stop-track', { detail: activeTrackId }));
      if (trackStingerKillers[activeTrackId]) trackStingerKillers[activeTrackId]();
    }
    Object.keys(trackCollapsers).forEach(id => {
      if (id !== track.id) trackCollapsers[id]();
    });
    activeTrackId = track.id;
    setDetailsExpanded(details, true);
    updateStingerAvailability();
    resumeAudioContext();
    playing = true;
    playingTrackIds.add(track.id); requestWakeLock();
    if (!isContinuation) trackPublicEvent('track_play', { trackId: track.id, mode: track.mode });
    if (isSequential) {
      playSequential(isContinuation);
    } else if (useQuantizedLoop) {
      // Un vrai démarrage à froid réinitialise le budget de boucles (le premier passage compte déjà comme 1) ;
      // un reroll ou une recherche en cours de lecture (isContinuation) ne remet pas le compteur à zéro et ne l'avance pas non plus.
      // Note : on ne peut pas déduire ça de `playing`, qui est déjà retombé à false par le stopAllSources(false)
      // que ces deux appelants font juste avant — d'où ce paramètre explicite plutôt qu'une lecture d'état ambiant.
      if (!isContinuation) loopsPlayed = 1;
      playQuantized(offsetAt % track.duration, reroll !== false);
    } else {
      playSimple();
    }
    playIcon.innerHTML = PAUSE_SVG;
    if (statusEl) statusEl.textContent = t('playingStatus');
    tick();
  }

  function rerollPool() {
    if (!isVerticalRandom) return;
    trackPublicEvent('pool_refresh', { trackId: track.id });
    if (playing) {
      const currentOffset = currentPlaybackOffset();
      stopAllSources(false);
      offsetAt = currentOffset;
      playThisTrack(true, true);
    } else {
      lastPickedIndex = lastPickedIndex.map(() => -1);
    }
  }

  const titleToggle = wrapper.querySelector('[data-role="titleToggle"]');
  if (titleToggle) titleToggle.addEventListener('click', updateStingerAvailability);
  const refreshPoolBtn = wrapper.querySelector('[data-role="refreshPool"]');
  if (refreshPoolBtn) refreshPoolBtn.addEventListener('click', rerollPool);

  wrapper.querySelectorAll('[data-voice-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.voiceKey;
      const action = btn.dataset.voiceAction;
      const set = action === 'solo' ? soloedVoices : mutedVoices;
      if (set.has(key)) set.delete(key); else set.add(key);
      const active = set.has(key);
      btn.classList.toggle('active', active);
      refreshVoiceGains();
      trackPublicEvent(action === 'solo' ? 'voice_solo_toggle' : 'voice_mute_toggle', { trackId: track.id, voice: key, active });
    });
  });
  if (goToEndBtn) {
    goToEndBtn.addEventListener('click', () => {
      if (!playing || goToEndRequested) return;
      goToEndRequested = true;
      goToEndBtn.disabled = true;
      goToEndBtn.textContent = track.outro ? t('endingWithOutro') : t('endingLastSegment');
      trackPublicEvent('go_to_end_click', { trackId: track.id });
    });
  }

  document.addEventListener('stop-track', (e) => { if (e.detail === track.id) stopAllSources(); });
  // Reprise après mise en veille de l'écran ou passage en arrière-plan : les minuteurs de programmation
  // et l'horloge audio peuvent avoir été suspendus pendant ce temps, laissant une programmation obsolète
  // qui resterait silencieuse indéfiniment sans ça. On relance proprement depuis la position actuelle
  // plutôt que de laisser un état incohérent qui obligerait à recharger la page.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !playing) return;
    resumeAudioContext();
    const resumeFrom = computeElapsed();
    stopAllSources(false);
    offsetAt = resumeFrom;
    playThisTrack(false, true);
  });
  playBtn.addEventListener('click', () => { playing ? stopAllSources() : playThisTrack(true); });

  if (wrap) {
    // Glisser-déposer sur la barre de lecture (pas juste un tap) : la position se met à jour en direct
    // pendant le glissement (y compris la waveform), et la vraie recherche audio (arrêt/redémarrage des
    // sources) ne se déclenche qu'au relâchement — sinon on redémarrerait l'audio à chaque pixel parcouru.
    function seekPctFromEvent(e) {
      const rect = wrap.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    }
    wrap.addEventListener('pointerdown', (e) => {
      isDraggingSeek = true;
      try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
      updateProgressAt(seekPctFromEvent(e) * progressMaxSec());
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!isDraggingSeek) return;
      updateProgressAt(seekPctFromEvent(e) * progressMaxSec());
    });
    wrap.addEventListener('pointerup', (e) => {
      if (!isDraggingSeek) return;
      isDraggingSeek = false;
      const seekTo = seekPctFromEvent(e) * progressMaxSec();
      if (playing) { stopAllSources(false); offsetAt = seekTo; playThisTrack(false, true); }
      else { offsetAt = seekTo; updateProgressAt(offsetAt); }
    });
    wrap.addEventListener('pointercancel', () => { isDraggingSeek = false; });
  }

  notchDots.forEach(dot => {
    dot.addEventListener('click', () => {
      level = parseInt(dot.dataset.level, 10);
      notchDots.forEach(d => d.classList.toggle('active', d === dot));
      trackPublicEvent('intensity_change', { trackId: track.id, level });
      if (!playing) return;
      const p = profiles[level];
      const now = ctx.currentTime;
      const gainsToRamp = useQuantizedLoop ? currentGainNodes : gains;
      gainsToRamp.forEach((g, i) => {
        if (!g) return;
        const layerGain = effGain(layersToLoad[i]);
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime((p[i] || 0) * layerGain * voiceGain('layer-' + i), now + 1.4);
      });
    });
  });

  stingerBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const idx = parseInt(btn.dataset.stinger, 10);
      const buf = stingerBuffers[idx];
      if (!buf) return;
      resumeAudioContext();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.setValueAtTime(effGain(stingerDefs[idx]), ctx.currentTime);
      src.connect(g); g.connect(ctx.destination);
      src.start(0);
      activeStingerSources.push(src);
      src.onended = () => { activeStingerSources = activeStingerSources.filter(s => s !== src); };
      trackPublicEvent('stinger_play', { trackId: track.id, stingerIndex: idx });
    });
  });

  if (loopCountSelect) {
    loopCountSelect.addEventListener('change', () => {
      // Mutation directe de l'objet track lu par schedulerTick à chaque cycle — s'applique donc au vol,
      // y compris en cours de lecture, sans avoir à relancer la piste.
      track.maxLoops = loopCountSelect.value === '' ? null : parseInt(loopCountSelect.value, 10);
      trackPublicEvent('track_loop_change', { trackId: track.id, maxLoops: track.maxLoops });
    });
  }

  async function loadArrayBuffer(item) {
    if (item.localFile) return await item.localFile.arrayBuffer();
    const v = track.publishedAt ? ('?v=' + encodeURIComponent(track.publishedAt)) : '';
    const res = await fetch(track.base + encodeURIComponent(item.file) + v);
    return await res.arrayBuffer();
  }
  // Relais de décodage : Safari (Mac et iOS, donc tout navigateur sur iPhone/iPad puisqu'Apple impose
  // WebKit) ne sait pas décoder l'Ogg Vorbis nativement via decodeAudioData — échec silencieux, capté
  // plus bas par le try/catch ("Erreur de chargement"). On tente d'abord le décodage natif (rapide, ne
  // change rien pour les navigateurs qui le supportent déjà), et seulement s'il échoue, on bascule sur
  // un décodeur Ogg Vorbis en JavaScript/WebAssembly, indépendant du support natif.
  // Volontairement une instance PAR PISTE (pas partagée au niveau du module) : plusieurs pistes chargent
  // leurs fichiers en parallèle au chargement de la page, et un décodeur partagé verrait ses appels
  // .reset()/.decode() de pistes différentes s'entremêler — corruption silencieuse plutôt qu'erreur.
  let vorbisDecoderPromise = null;
  function getVorbisDecoder() {
    if (!vorbisDecoderPromise) {
      vorbisDecoderPromise = (async () => {
        if (!window['ogg-vorbis-decoder']) throw new Error('Décodeur Ogg Vorbis de secours introuvable (bibliothèque non chargée)');
        const decoder = new window['ogg-vorbis-decoder'].OggVorbisDecoder();
        await decoder.ready;
        return decoder;
      })();
    }
    return vorbisDecoderPromise;
  }
  async function decodeAudioDataCompat(arrayBuffer) {
    try {
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch (nativeError) {
      const decoder = await getVorbisDecoder();
      await decoder.reset();
      const { channelData, samplesDecoded, sampleRate } = await decoder.decode(new Uint8Array(arrayBuffer));
      if (!samplesDecoded || !channelData || !channelData.length) throw nativeError;
      const audioBuffer = ctx.createBuffer(channelData.length, samplesDecoded, sampleRate);
      for (let ch = 0; ch < channelData.length; ch++) audioBuffer.copyToChannel(channelData[ch], ch);
      return audioBuffer;
    }
  }

  (async () => {
    let loaded = 0;
    let total;
    if (isVerticalRandom) {
      const rawGroups = track.randomGroups || [];
      const rawFixed = (track.fixedLayers || []).filter(layerHasSource);
      rawFixedLayers = rawFixed;
      total = rawFixed.length + rawGroups.reduce((n, g) => n + (g.alternatives || []).filter(layerHasSource).length, 0) + stingerDefs.length;
      fixedBuffers = new Array(rawFixed.length).fill(null);
      for (let fi = 0; fi < rawFixed.length; fi++) {
        try {
          const ab = await loadArrayBuffer(rawFixed[fi]);
          fixedBuffers[fi] = await decodeAudioDataCompat(ab);
          loaded++;
          if (statusEl) statusEl.textContent = t('loadingProgress', { loaded, total });
          // rawFixed est filtré (layerHasSource) : son index ne correspond pas forcément à celui de
          // track.fixedLayers utilisé par le gabarit — on retrouve la bonne case par référence d'objet.
          const origIndex = track.fixedLayers.indexOf(rawFixed[fi]);
          if (origIndex >= 0) drawVoiceWave(voiceWaveFixed[origIndex], fixedBuffers[fi]);
        } catch (e) { /* une couche fixe manquante ne bloque pas les autres */ }
      }
      if (fixedBuffers.every(b => !b)) { if (statusEl) statusEl.textContent = t('loadErrorNoFixedLayers'); setLoadErrorIcon(); return; }
      for (let gi = 0; gi < rawGroups.length; gi++) {
        const alts = rawGroups[gi].alternatives || [];
        // Même longueur que les alternatives déclarées, y compris les slots vides (intentionnels : ils restent
        // un choix possible du tirage, avec pour effet un cycle silencieux pour ce groupe — pas un fichier à charger).
        groupBuffers[gi] = new Array(alts.length).fill(null);
        lastPickedIndex[gi] = -1;
        for (let ai = 0; ai < alts.length; ai++) {
          if (!layerHasSource(alts[ai])) continue;
          try {
            const ab = await loadArrayBuffer(alts[ai]);
            groupBuffers[gi][ai] = await decodeAudioDataCompat(ab);
            loaded++;
            if (statusEl) statusEl.textContent = t('loadingProgress', { loaded, total });
          } catch (e) { /* fichier manquant : ce tirage restera silencieux plutôt que de bloquer la lecture */ }
        }
      }
    } else if (isSequential) {
      const hasIntro = layerHasSource(track.intro);
      const hasOutro = layerHasSource(track.outro);
      const segs = (track.segments || []).filter(layerHasSource);
      total = (hasIntro ? 1 : 0) + (hasOutro ? 1 : 0) + segs.length + stingerDefs.length;
      segmentBuffers = new Array((track.segments || []).length).fill(null);
      if (hasIntro) {
        try {
          const ab = await loadArrayBuffer(track.intro);
          introBuffer = await decodeAudioDataCompat(ab);
          loaded++;
          if (statusEl) statusEl.textContent = t('loadingProgress', { loaded, total });
        } catch (e) { /* intro manquante : la lecture démarrera directement sur un segment */ }
      }
      if (hasOutro) {
        try {
          const ab = await loadArrayBuffer(track.outro);
          outroBuffer = await decodeAudioDataCompat(ab);
          loaded++;
          if (statusEl) statusEl.textContent = t('loadingProgress', { loaded, total });
        } catch (e) { /* outro manquante : "Aller vers la fin" laissera simplement filer le segment en cours */ }
      }
      for (let sgi = 0; sgi < (track.segments || []).length; sgi++) {
        if (!layerHasSource(track.segments[sgi])) continue;
        try {
          const ab = await loadArrayBuffer(track.segments[sgi]);
          segmentBuffers[sgi] = await decodeAudioDataCompat(ab);
          loaded++;
          if (statusEl) statusEl.textContent = t('loadingProgress', { loaded, total });
        } catch (e) { /* segment manquant : simplement absent du tirage, ne bloque pas le reste */ }
      }
      if (segmentBuffers.every(b => !b)) { if (statusEl) statusEl.textContent = t('loadErrorNoSegments'); setLoadErrorIcon(); return; }
    } else {
      total = layersToLoad.length + stingerDefs.length;
      for (let i = 0; i < layersToLoad.length; i++) {
        try {
          const ab = await loadArrayBuffer(layersToLoad[i]);
          buffers[i] = await decodeAudioDataCompat(ab);
          loaded++;
          if (statusEl) statusEl.textContent = t('loadingProgress', { loaded, total });
        } catch (e) { if (statusEl) statusEl.textContent = t('loadErrorStatus'); setLoadErrorIcon(); return; }
      }
      if (isStatic && buffers[0] && waveformBg) {
        try {
          waveformPeaks = computeWaveformPeaks(buffers[0], 200);
          redrawWaveforms();
        } catch (e) { /* la waveform est un bonus visuel : un échec ici ne doit jamais bloquer la lecture */ }
      }
    }
    for (let i = 0; i < stingerDefs.length; i++) {
      try {
        const ab = await loadArrayBuffer(stingerDefs[i]);
        stingerBuffers[i] = await decodeAudioDataCompat(ab);
        loaded++;
        if (statusEl) statusEl.textContent = t('loadingProgress', { loaded, total });
      } catch (e) { /* un stinger manquant ne bloque pas la lecture principale */ }
    }
    // Pour une source locale non encore publiée, la durée réelle n'est connue qu'une fois décodée.
    const allMainBuffers = isVerticalRandom
      ? [...fixedBuffers, ...groupBuffers.flat()].filter(Boolean)
      : isSequential
      ? [introBuffer, outroBuffer, ...segmentBuffers].filter(Boolean)
      : buffers.filter(Boolean);
    const decodedMax = Math.max(0, ...allMainBuffers.map(b => b.duration), ...stingerBuffers.filter(Boolean).map(b => b.duration));
    if (decodedMax > (track.duration || 0)) {
      track.duration = decodedMax;
      if (timeTotal) timeTotal.textContent = formatTime(progressMaxSec());
    }
    if (statusEl) statusEl.textContent = t('readyStatus');
    playBtn.disabled = false;
    playBtn.setAttribute('aria-label', t('playAriaLabel'));
    playIcon.classList.remove('loading-icon');
    playIcon.innerHTML = PLAY_SVG;
    ready = true;
    updateStingerAvailability();
  })();
}

/* ---------------- Init ---------------- */



/* ---------------- Accessibilité : contraste renforcé ---------------- */
// Case à cocher côté visiteur (mémorisée sur ce navigateur via localStorage) qui remplace les couleurs
// personnalisées (celles de l'AdReel ou du pack) par une palette à fort contraste, lisible quel que
// soit le choix esthétique du compositeur. Purement client, aucune dépendance backend.
const HIGH_CONTRAST_VARS = {
  '--bg': '#ffffff', '--bg-card': '#ffffff', '--text': '#000000',
  '--text-dim': '#1a1a1a', '--text-dimmer': '#3a3a3a', '--border': '#000000',
  '--accent': '#a3390f', '--accent-soft': '#f4d9cb'
};
function setupContrastToggle(toggleId, customBg, customText) {
  const toggle = document.getElementById(toggleId);
  if (!toggle) return;
  const root = document.documentElement;
  function apply(on) {
    if (on) {
      Object.keys(HIGH_CONTRAST_VARS).forEach(key => root.style.setProperty(key, HIGH_CONTRAST_VARS[key]));
    } else {
      Object.keys(HIGH_CONTRAST_VARS).forEach(key => root.style.removeProperty(key));
      if (customBg) root.style.setProperty('--bg', customBg);
      if (customText) root.style.setProperty('--text', customText);
    }
    document.body.classList.toggle('high-contrast', on);
    document.dispatchEvent(new CustomEvent('layerpitch-contrast-changed'));
  }
  let saved = false;
  try { saved = localStorage.getItem('layerpitch-high-contrast') === '1'; } catch (e) {}
  toggle.checked = saved;
  apply(saved);
  toggle.addEventListener('change', () => {
    apply(toggle.checked);
    try { localStorage.setItem('layerpitch-high-contrast', toggle.checked ? '1' : '0'); } catch (e) {}
  });
}

window.LayerPlayerCore = {
  formatTime,
  cumulativeProfiles,
  section,
  escapeHtml,
  linkify,
  layerHasSource,
  buildTrackRow,
  initTrackPlayer,
  renderTracksBlock,
  setupContrastToggle,
  getModeLabel,
  setLang,
  PLAYABLE_MODES
};

})();
