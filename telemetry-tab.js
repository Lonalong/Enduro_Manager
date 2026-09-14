/* ============================================================
   TELEMETRY TAB — separate file on purpose (see index.html, which
   only adds: a nav button, an empty <div id="tab-telemetry">, and a
   <script src="telemetry-tab.js"> include). Everything about this
   tab's markup, styling hooks, and iRacing polling lives here so the
   main file doesn't grow every time this tab changes.

   REQUIRES the same iRacing Telemetry Bridge script the Race tab's
   "⚡ iRacing" button already needs, but talks to a different,
   additive endpoint: /telemetry/full (see iracing_bridge.py). The
   existing /telemetry endpoint the Race tab uses is untouched.

   BEHAVIOUR (per product decisions made with the user):
   - Nothing connects automatically. Opening/reloading the tab always
     starts at STANDBY — the person must press "Connect to iRacing".
   - Once connected, polls the bridge continuously (~350ms) until
     "Stop Live Feed" is pressed or the tab/page is closed.
   - Tyres + fuel level redraw on EVERY poll (as instant as the poll
     rate allows) since they change continuously.
   - Everything lap-scoped (standings, your lap-time cards, sectors)
     only redraws when the bridge reports a NEW completed lap — avoids
     visual jitter on data that's only meaningful once per lap anyway.
   - Session type (Practice/Qualifying/Race) changes what the header
     shows (a race has a lap count; practice/qualifying don't) and
     will eventually change what "standings" means (session-best
     ranking vs. live track position) — see telRenderHeader's comment.
   ============================================================ */

var TEL_BRIDGE_FULL_URL = (typeof IR_BRIDGE_URL !== 'undefined')
  ? IR_BRIDGE_URL.replace('/telemetry', '/telemetry/full')
  : 'http://127.0.0.1:8765/telemetry/full';

var telState = {
  connected: false,     // always false on load/reload — see file header
  pollTimer: null,
  lastLap: null,        // last LapCompleted we redrew lap-scoped panels for
  lastData: null,       // most recent full payload, for the sector toggle to re-render from without waiting on a new poll
  sectorMode: 'ahead',  // 'leader' | 'ahead'
  domBuilt: false,
  // Rolling fuel-per-lap calc: captured at the instant a new lap completes.
  fuelAtLapStart: null,
  actualFuelPerLap: null,
};

// ── Empty/placeholder states — shown before Connect is pressed, and
// restored when Stop Live Feed is pressed, so the tab always reads as
// "ready and waiting" rather than blank/broken. ─────────────────────

function telPlaceholderHeader() {
  return '<div class="tel-header-placeholder">Session info appears once connected</div>';
}

function telPlaceholderStandings() {
  return (
    '<div class="tel-row tel-row-hdr">' +
      '<span class="tel-c-pos">POS</span><span class="tel-c-car">CAR</span>' +
      '<span class="tel-c-gap">GAP</span><span class="tel-c-int">INT</span><span class="tel-c-last">LAST</span>' +
    '</div>' +
    '<div class="tel-empty-sm">Standings appear once connected and on track</div>'
  );
}

function telPlaceholderLapStats() {
  return telStatCard('LAST LAP', '--:--.-', 'tel-placeholder') +
    telStatCard('BEST LAP', '--:--.-', 'tel-placeholder') +
    telStatCard('AVG LAP', '--:--.-', 'tel-placeholder');
}

function telPlaceholderFuelStats() {
  return telStatCard('FUEL LEVEL', '-- L', 'tel-placeholder') +
    telStatCard('TARGET /LAP', '-- L', 'tel-placeholder') +
    telStatCard('ACTUAL /LAP', '-- L', 'tel-placeholder') +
    telStatCard('LAPS LEFT', '--', 'tel-placeholder');
}

function telPlaceholderTyres() {
  return ['FL', 'FR', 'RL', 'RR'].map(function (pos) {
    return (
      '<div class="tel-tyre">' +
        '<div class="tel-tyre-strip tel-tyre-strip-placeholder"><span></span><span></span><span></span></div>' +
        '<div class="tel-tyre-pos tel-placeholder">' + pos + '</div>' +
        '<div class="tel-tyre-wear tel-placeholder">--%</div>' +
      '</div>'
    );
  }).join('');
}

function telPlaceholderSectors() {
  return '<div class="tel-empty-sm">Sector comparison appears once connected and a lap is completed</div>';
}

function telResetToPlaceholders() {
  var header = document.getElementById('telHeader');
  if (header) { header.classList.add('tel-empty'); header.innerHTML = telPlaceholderHeader(); }
  var standings = document.getElementById('telStandings');
  if (standings) standings.innerHTML = telPlaceholderStandings();
  var lapStats = document.getElementById('telLapStats');
  if (lapStats) lapStats.innerHTML = telPlaceholderLapStats();
  var fuelStats = document.getElementById('telFuelStats');
  if (fuelStats) fuelStats.innerHTML = telPlaceholderFuelStats();
  var tyres = document.getElementById('telTyres');
  if (tyres) tyres.innerHTML = telPlaceholderTyres();
  var badge = document.getElementById('telTyreLiveBadge');
  if (badge) { badge.textContent = ''; badge.className = 'tel-tyre-live-badge'; }
  var stripEl = document.getElementById('telSectorStrip');
  if (stripEl) { stripEl.className = 'tel-sectorstrip'; stripEl.innerHTML = ''; }
  var sectorList = document.getElementById('telSectorList');
  if (sectorList) sectorList.innerHTML = telPlaceholderSectors();
  var sectorFoot = document.getElementById('telSectorFoot');
  if (sectorFoot) sectorFoot.textContent = '';
}

// ── Tab skeleton (built once per page load, refreshed on data after) ────

function telRenderTab() {
  var host = document.getElementById('tab-telemetry');
  if (!host) return;

  if (!telState.domBuilt) {
    host.innerHTML =
      '<div class="tel-wrap">' +
        '<div class="tel-connectbar">' +
          '<button class="tel-connect-btn" id="telConnectBtn">&#9889; Connect to iRacing</button>' +
          '<div class="tel-status" id="telStatusDot"><span class="tel-dot tel-dot-standby"></span><span>STANDBY</span></div>' +
        '</div>' +
        '<div id="telHeader" class="tel-header tel-empty"></div>' +
        '<div id="telStandings" class="tel-standings"></div>' +
        '<div class="tel-yourcar-label"><span class="tel-accent-bar tel-accent-ac"></span>YOUR CAR</div>' +
        '<div id="telLapStats" class="tel-lapstats"></div>' +
        '<div id="telFuelStats" class="tel-fuelstats"></div>' +
        '<div class="tel-bottom-row">' +
          '<div class="tel-col">' +
            '<div class="tel-panel-label tel-panel-label-row">' +
              '<span><span class="tel-accent-bar tel-accent-ac"></span>TYRES</span>' +
              '<span id="telTyreLiveBadge" class="tel-tyre-live-badge tel-badge-unknown">CHECKING\u2026</span>' +
            '</div>' +
            '<div id="telTyres" class="tel-tyres"></div>' +
          '</div>' +
          '<div class="tel-col">' +
            '<div class="tel-panel-label tel-panel-label-row">' +
              '<span><span class="tel-accent-bar tel-accent-ye"></span>SECTORS</span>' +
              '<div class="tel-toggle" id="telSectorToggle">' +
                '<span class="tel-toggle-opt" data-mode="leader">LDR</span>' +
                '<span class="tel-toggle-opt tel-toggle-active" data-mode="ahead">AHEAD</span>' +
              '</div>' +
            '</div>' +
            '<div id="telSectorStrip" class="tel-sectorstrip"></div>' +
            '<div id="telSectorList" class="tel-sectorlist"></div>' +
            '<div id="telSectorFoot" class="tel-sectorfoot"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('telConnectBtn').addEventListener('click', telToggleConnect);
    document.getElementById('telSectorToggle').addEventListener('click', function (e) {
      var opt = e.target.closest('.tel-toggle-opt');
      if (!opt) return;
      telState.sectorMode = opt.dataset.mode;
      document.querySelectorAll('#telSectorToggle .tel-toggle-opt').forEach(function (el) {
        el.classList.toggle('tel-toggle-active', el === opt);
      });
      if (telState.lastData) telRenderSectors(telState.lastData); // instant, no need to wait for next poll
    });

    telState.domBuilt = true;
    telResetToPlaceholders(); // paint the "ready and waiting" state immediately, before any Connect click
  }

  telSetStatus(telState.connected ? 'connected' : 'standby');
}

// ── Connect / disconnect ─────────────────────────────────────────────

function telToggleConnect() {
  if (telState.connected) telDisconnect(); else telConnect();
}

function telConnect() {
  telState.connected = true;
  telState.lastLap = null;   // force a full lap-scoped redraw on the very next poll
  telState.fuelAtLapStart = null;
  telState.actualFuelPerLap = null;
  // Fresh session, fresh guess about whether this car exposes live tyre
  // data — see telDetectTyreLiveness. Most cars don't (iRacing withholds
  // it on-track by design); a few with real TPMS do.
  telState.tyreLiveness = 'unknown'; // 'unknown' | 'live' | 'snapshot'
  telState.prevTyres = null;
  var btn = document.getElementById('telConnectBtn');
  if (btn) { btn.textContent = '\u25CF Stop Live Feed'; btn.classList.add('tel-connect-btn-active'); }
  telSetStatus('connected');
  telPoll(); // immediate first read, don't wait a full interval
  telState.pollTimer = setInterval(telPoll, 350);
}

function telDisconnect() {
  telState.connected = false;
  if (telState.pollTimer) { clearInterval(telState.pollTimer); telState.pollTimer = null; }
  var btn = document.getElementById('telConnectBtn');
  if (btn) { btn.textContent = '\u26A1 Connect to iRacing'; btn.classList.remove('tel-connect-btn-active'); }
  telSetStatus('standby');
  telResetToPlaceholders(); // don't leave stale last-known data on screen once stopped
}

function telSetStatus(kind) {
  var el = document.getElementById('telStatusDot');
  if (!el) return;
  var map = {
    standby: ['tel-dot-standby', 'STANDBY'],
    connected: ['tel-dot-connected', 'CONNECTED'],
    nosignal: ['tel-dot-nosignal', 'NO SIGNAL'],
  };
  var m = map[kind] || map.standby;
  el.innerHTML = '<span class="tel-dot ' + m[0] + '"></span><span>' + m[1] + '</span>';
}

// ── Polling ──────────────────────────────────────────────────────────

function telPoll() {
  if (!telState.connected) return;
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 1500);
  fetch(TEL_BRIDGE_FULL_URL, ctrl ? { signal: ctrl.signal } : {})
    .then(function (r) { return r.json(); })
    .then(function (data) {
      clearTimeout(to);
      if (!telState.connected) return; // Stop was pressed while this request was in flight
      if (!data || !data.connected) { telSetStatus('nosignal'); return; }
      telSetStatus('connected');
      telState.lastData = data;

      // Instant, every tick — these change continuously (when the car
      // supports it — see telDetectTyreLiveness).
      telDetectTyreLiveness(data);
      telRenderTyres(data);
      telRenderFuelStats(data);

      // Lap-scoped — only redraw when a new lap has actually completed
      // (or this is the first successful read since Connect).
      if (telState.lastLap === null || data.lap !== telState.lastLap) {
        if (telState.lastLap !== null && data.fuelLevel != null && telState.fuelAtLapStart != null) {
          var used = telState.fuelAtLapStart - data.fuelLevel;
          if (used > 0) telState.actualFuelPerLap = used;
        }
        telState.fuelAtLapStart = data.fuelLevel;
        telState.lastLap = data.lap;

        telRenderHeader(data);
        telRenderStandings(data);
        telRenderLapStats(data);
        telRenderSectors(data);
      }
    })
    .catch(function () {
      clearTimeout(to);
      if (telState.connected) telSetStatus('nosignal'); // keep polling — bridge may come back
    });
}

// ── Formatting helpers ───────────────────────────────────────────────

function telFmtLapTime(sec) {
  if (sec == null || sec < 0) return '--:--.-';
  var m = Math.floor(sec / 60), s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

function telFmtClock(sec) {
  if (sec == null || sec < 0) return '--';
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function telFmtDelta(sec) {
  if (sec == null) return '\u2013';
  return (sec >= 0 ? '+' : '') + sec.toFixed(1);
}

// ── Tyre live-data detection ─────────────────────────────────────────
// iRacing deliberately withholds live tyre pressure/temp/wear while
// on-track for most cars (anti-cheat — matches the in-car "black box"
// pit review screen, which only refreshes when you're actually in the
// pits). A handful of cars with real-world TPMS DO expose it live. Since
// that list can change over time, detect it at runtime instead of
// hard-coding cars: if values are actually moving while driving (not on
// pit road), this car supports live data — flip the badge on and leave
// it on for the rest of the session.
function telDetectTyreLiveness(data) {
  if (telState.tyreLiveness === 'live') return; // already confirmed, nothing to re-check
  var t = data.tyres || {};
  var prev = telState.prevTyres;
  if (!data.onPitRoad && prev) {
    var changed = ['lf', 'rf', 'lr', 'rr'].some(function (k) {
      var a = prev[k] || {}, b = t[k] || {};
      var dP = (a.pressureKpa != null && b.pressureKpa != null) ? Math.abs(a.pressureKpa - b.pressureKpa) : 0;
      var dT = (a.tempC != null && b.tempC != null) ? Math.abs(a.tempC - b.tempC) : 0;
      return dP > 0.3 || dT > 0.3; // small threshold — real sensor noise, not float jitter
    });
    if (changed) telState.tyreLiveness = 'live';
    else if (telState.tyreLiveness === 'unknown') telState.tyreLiveness = 'snapshot';
  }
  telState.prevTyres = t;

  var badge = document.getElementById('telTyreLiveBadge');
  if (badge) {
    if (telState.tyreLiveness === 'live') {
      badge.textContent = 'LIVE'; badge.className = 'tel-tyre-live-badge tel-badge-live';
    } else if (telState.tyreLiveness === 'snapshot') {
      badge.textContent = 'AS OF LAST PIT STOP'; badge.className = 'tel-tyre-live-badge tel-badge-snapshot';
    } else {
      badge.textContent = 'CHECKING\u2026'; badge.className = 'tel-tyre-live-badge tel-badge-unknown';
    }
  }
}

// ── Section renderers ────────────────────────────────────────────────

function telRenderHeader(data) {
  var el = document.getElementById('telHeader');
  if (!el) return;
  el.classList.remove('tel-empty');

  var badgeClass = { race: 'tel-badge-race', qualify: 'tel-badge-qual', practice: 'tel-badge-prac' }[data.sessionType] || 'tel-badge-prac';
  var badgeLabel = { race: 'RACE', qualify: 'QUALIFYING', practice: 'PRACTICE' }[data.sessionType] || (data.sessionType || '').toUpperCase();

  // Race: show lap count (if the session actually has a fixed lap total)
  // plus time remaining. Practice/Qualifying: lap counts aren't a
  // meaningful concept (position there is session-best ranking, not
  // track position) — see telRenderStandings — so just show time.
  var mid;
  if (data.sessionType === 'race') {
    var lapPart = 'Lap ' + (data.lap != null ? data.lap : '\u2013');
    if (!data.isUnlimitedLaps && data.sessionLapsRemain != null && data.lap != null) {
      lapPart += '/' + (data.lap + data.sessionLapsRemain);
    }
    var timePart = (!data.isUnlimitedTime && data.sessionTimeRemain != null)
      ? telFmtClock(data.sessionTimeRemain) + ' remaining' : '';
    mid = data.trackName ? (data.trackName + ' &middot; ') : '';
    mid += lapPart + (timePart ? (' &middot; ' + timePart) : '');
  } else {
    mid = (data.trackName ? (data.trackName + ' &middot; ') : '') +
      (data.sessionTimeRemain != null ? telFmtClock(data.sessionTimeRemain) + ' remaining' : '');
  }

  var w = data.weather || {};
  var weatherPart = (w.airTempC != null ? Math.round(w.airTempC) + '\u00b0C air' : '') +
    (w.trackTempC != null ? ' / ' + Math.round(w.trackTempC) + '\u00b0C track' : '');

  el.innerHTML =
    '<span class="tel-badge ' + badgeClass + '">' + badgeLabel + '</span>' +
    '<span class="tel-header-mid">' + mid + '</span>' +
    '<span class="tel-header-weather">' + weatherPart + '</span>';
}

function telRenderStandings(data) {
  var el = document.getElementById('telStandings');
  if (!el) return;
  var cars = data.cars || [];
  if (!cars.length) { el.innerHTML = '<div class="tel-empty-sm">No standings data yet.</div>'; return; }

  var rowsHtml = cars.map(function (c) {
    var isYou = c.isYou;
    return '<div class="tel-row' + (isYou ? ' tel-row-you' : (c.position === 1 ? ' tel-row-leader' : '')) + '">' +
      '<span class="tel-c-pos">' + c.position + '</span>' +
      '<span class="tel-c-car">' + (isYou ? 'YOU' : ('#' + c.carNumber + ' ' + (c.name || ''))) + '</span>' +
      '<span class="tel-c-gap">' + (c.position === 1 ? 'LDR' : (c.gap != null ? telFmtDelta(c.gap) : '\u2013')) + '</span>' +
      '<span class="tel-c-int">' + (c.interval != null ? telFmtDelta(c.interval) : '\u2013') + '</span>' +
      '<span class="tel-c-last">' + telFmtLapTime(c.lastLapTime) + '</span>' +
    '</div>';
  }).join('');

  el.innerHTML =
    '<div class="tel-row tel-row-hdr">' +
      '<span class="tel-c-pos">POS</span><span class="tel-c-car">CAR</span>' +
      '<span class="tel-c-gap">GAP</span><span class="tel-c-int">INT</span><span class="tel-c-last">LAST</span>' +
    '</div>' +
    '<div class="tel-standings-scroll">' + rowsHtml + '</div>';
}

function telRenderLapStats(data) {
  var el = document.getElementById('telLapStats');
  if (!el) return;
  el.innerHTML =
    telStatCard('LAST LAP', telFmtLapTime(data.lapLastTime)) +
    telStatCard('BEST LAP', telFmtLapTime(data.lapBestTime), 'tel-good') +
    telStatCard('AVG LAP', telFmtLapTime(data.lapCurrentTime)); // current-lap avg proxy until we have a real running average
}

function telRenderFuelStats(data) {
  var el = document.getElementById('telFuelStats');
  if (!el) return;
  var target = (typeof rp !== 'undefined' && rp && rp.fuelPerLap) ? rp.fuelPerLap : null;
  var actual = telState.actualFuelPerLap;
  var fuel = data.fuelLevel;
  var lapsLeft = (fuel != null && actual) ? (fuel / actual) : (fuel != null && target ? (fuel / target) : null);

  el.innerHTML =
    telStatCard('FUEL LEVEL', fuel != null ? fuel.toFixed(1) + ' L' : '\u2013') +
    telStatCard('TARGET /LAP', target ? target.toFixed(2) + ' L' : '\u2013') +
    telStatCard('ACTUAL /LAP', actual ? actual.toFixed(2) + ' L' : '\u2013',
                (target && actual && actual > target) ? 'tel-warn' : '') +
    telStatCard('LAPS LEFT', lapsLeft != null ? lapsLeft.toFixed(1) : '\u2013');
}

function telStatCard(label, value, extraClass) {
  return '<div class="tel-stat"><div class="tel-stat-label">' + label + '</div>' +
    '<div class="tel-stat-value ' + (extraClass || '') + '">' + value + '</div></div>';
}

// ── Temperature color scale (drives the tyre strip's 3 zones only —
// wear % and pressure have their own separate, independent color rules).
function telTempColor(c) {
  if (c == null) return 'var(--bd)';
  if (c < 70) return '#3a7bd5';           // cold — hasn't reached working range
  if (c < 100) return 'var(--tg)';        // optimal
  if (c < 115) return 'var(--ye)';        // running hot
  return 'var(--re)';                     // overheating
}

function telRenderTyres(data) {
  var el = document.getElementById('telTyres');
  if (!el) return;
  var t = data.tyres || {};
  var order = [['lf', 'FL'], ['rf', 'FR'], ['lr', 'RL'], ['rr', 'RR']];
  el.innerHTML = order.map(function (pair) {
    var v = t[pair[0]] || {};
    var wear = v.wearPct;
    var wearClass = wear == null ? '' : (wear >= 70 ? 'tel-good' : (wear >= 50 ? 'tel-warn' : 'tel-bad'));
    var tempClass = (v.tempC != null && v.tempC >= 100) ? 'tel-bad' : '';
    var zones = v.tempZones || {};
    // Strip zones are drawn in outer -> mid -> inner order, left to right,
    // regardless of which side of the car the tyre is on — the bridge has
    // already corrected for FL/RL vs FR/RR having their raw L/R readings
    // mirrored, so "outer" here always means the same physical edge.
    var outerColor = telTempColor(zones.outer);
    var midColor = telTempColor(zones.mid);
    var innerColor = telTempColor(zones.inner);
    return (
      '<div class="tel-tyre">' +
        '<div class="tel-tyre-strip">' +
          '<span style="background:' + outerColor + '"></span>' +
          '<span style="background:' + midColor + '"></span>' +
          '<span style="background:' + innerColor + '"></span>' +
        '</div>' +
        '<div class="tel-tyre-pos">' + pair[1] + '</div>' +
        '<div class="tel-tyre-wear ' + wearClass + '">' + (wear != null ? wear + '%' : '\u2013') + '</div>' +
        '<div class="tel-tyre-sub">' + (v.pressureKpa != null ? Math.round(v.pressureKpa) + ' kPa' : '\u2013') + '</div>' +
        '<div class="tel-tyre-sub ' + tempClass + '">' + (v.tempC != null ? Math.round(v.tempC) + '\u00b0C' : '\u2013') + '</div>' +
      '</div>'
    );
  }).join('');
}

function telRenderSectors(data) {
  var stripEl = document.getElementById('telSectorStrip');
  var listEl = document.getElementById('telSectorList');
  var footEl = document.getElementById('telSectorFoot');
  if (!stripEl || !listEl || !footEl) return;

  var sec = data.sectors || {};
  var rows = telState.sectorMode === 'leader' ? (sec.vsLeader || []) : (sec.vsAhead || []);
  var widths = sec.widths || [];

  if (!rows.length) {
    stripEl.innerHTML = '';
    listEl.innerHTML = '<div class="tel-empty-sm">No sector data for this track/session yet \u2014 need at least one completed lap.</div>';
    footEl.innerHTML = '';
    return;
  }

  // At high sector counts, a busy track eats its own legibility: the "S"
  // prefix plus the strip's gap/border all cost space that matters more
  // as segments get numerous and individually narrower. Above 8 sectors,
  // switch to a denser variant — bare numbers, tighter gap/border —
  // rather than letting text clip or segments look overcrowded.
  var DENSE_THRESHOLD = 8;
  var isDense = rows.length > DENSE_THRESHOLD;
  stripEl.className = 'tel-sectorstrip' + (isDense ? ' tel-sectorstrip-dense' : '');

  // Strip: "S1"/"S2" labels normally, bare "1"/"2" once dense — widths
  // proportional to each sector's real length either way. Bordered
  // pit-board-style blocks — see telemetry-tab.css .tel-seg.
  stripEl.innerHTML = rows.map(function (r, i) {
    var w = widths[i] != null ? widths[i] : (1 / rows.length);
    var cls = r.delta == null ? 'tel-seg-neutral' : (r.delta <= 0 ? 'tel-seg-good' : 'tel-seg-bad');
    var label = isDense ? String(r.sector) : ('S' + r.sector);
    return '<div class="tel-seg ' + cls + '" style="flex:' + w + '">' + label + '</div>';
  }).join('');

  listEl.innerHTML = rows.map(function (r) {
    var cls = r.delta == null ? '' : (r.delta <= 0 ? 'tel-good' : 'tel-bad');
    return '<div class="tel-sector-row"><span>Sector ' + r.sector + '</span>' +
      '<span class="' + cls + '">' + telFmtDelta(r.delta) + '</span></div>';
  }).join('');

  var worst = rows.reduce(function (w, r) { return (r.delta != null && (w == null || r.delta > w.delta)) ? r : w; }, null);
  var refLabel = telState.sectorMode === 'leader' ? 'leader' : ('#' + (sec.aheadCarNumber || '?') + ', currently ahead');
  footEl.textContent = (worst ? ('Sector ' + worst.sector + ' costing the most time \u00b7 ') : '') + 'vs ' + refLabel + ' \u00b7 swaps automatically';
}

// ── Wire into the app's existing tab-switch handler ─────────────────
// index.html's click handler for .tab-btn calls this when the
// Telemetry tab is opened (see the one-line hook added there). Kept
// as its own named function so that hook stays a single readable line.
function telOnTabOpened() {
  telRenderTab();
}
