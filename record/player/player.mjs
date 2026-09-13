/*
 * The renderer's engine. `EDIT` (edit.mjs) is the shot list; this turns it into DOM and a single
 * `seek(t)` that puts the page into the exact state for second `t`.
 *
 * Two rules the whole file is built around:
 *
 *   1. **Visual state is a pure function of t.** No CSS transitions, no requestAnimationFrame
 *      loops, no `setTimeout`. Every opacity and offset is computed from t on demand. The renderer
 *      screenshots frames as fast as the machine allows, which is nothing like real time, so
 *      anything driven by wall-clock would smear.
 *   2. **Nothing on screen is text this file invented.** Terminal frames come from the casts in
 *      `docs/evidence/casts/`, code panes fetch the real source file, doc panes fetch the real
 *      markdown, and the zoom callouts are *sliced out of the cast they sit on top of* by matching
 *      a line — so a callout cannot quote something the command did not print. Captions are the one
 *      exception, and they are the video's own voice. In the v2 cut a callout may also carry an
 *      `explain` line, which is editorial for the same reason a caption is, and is styled in the
 *      caption's typeface rather than the terminal's so the two registers stay visibly apart.
 */

import { Terminal } from "/vendor/xterm.mjs";

/**
 * Two cuts share this engine. `?cut=v2` loads `edit.v2.mjs`, the second mockup: a terminal dressed
 * as the machine it was recorded on rather than as a player, annotation cards that explain what a
 * line is evidence *of*, and three-tier captions that name the sponsor technology in play. `edit.mjs`
 * (the first cut, already rendered to `record/out/sentinel-demo.mp4`) is untouched and still the
 * default, so both cuts render from one engine and neither can quietly break the other.
 */
const CUT = new URLSearchParams(location.search).get("cut") === "v2" ? "v2" : "v1";
const { EDIT, FPS } = await import(CUT === "v2" ? "/player/edit.v2.mjs" : "/player/edit.mjs");
/** v2 opts into the reworked chrome; everything else in this file is shared. */
const V2 = EDIT.style === "v2";
document.body.dataset.cut = CUT;

const stage = document.getElementById("segments");
const captionBox = document.getElementById("caption");
const trackTag = document.getElementById("tracktag");
const progress = document.getElementById("progress");

const text = (url) => fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${url}`))));
const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${url}`))));

/** Linear 0→1 over [a,b], clamped. The only easing primitive here. */
const ramp = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : Math.min(1, Math.max(0, (t - a) / (b - a))));
/** Fade in over `fin`, out over `fout` before the end. */
const fade = (t, dur, fin = 0.35, fout = 0.35) => Math.min(ramp(t, 0, fin), 1 - ramp(t, dur - fout, dur));
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g;
const plain = (s) => s.replace(ANSI, "");

const el = (tag, cls, parent) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (parent) parent.appendChild(node);
  return node;
};

// ─────────────────────────────────────────────────────────────────── segment kinds

/**
 * A card: lines of text appearing one at a time. `at` is when each line starts, so a card is a
 * timed thing rather than a slide with a paragraph on it.
 */
function buildCard(spec, root) {
  const wrap = el("div", "card", root);
  const lines = spec.lines.map((line) => {
    const node = el("div", `card-line ${line.class ?? ""}`, wrap);
    node.innerHTML = line.html;
    return { node, at: line.at, hold: line.hold ?? spec.dur - line.at };
  });
  return (t) => {
    for (const line of lines) {
      const local = t - line.at;
      const o = local < 0 ? 0 : Math.min(1, ramp(local, 0, 0.5)) * (1 - ramp(local, line.hold - 0.4, line.hold));
      line.node.style.opacity = o.toFixed(3);
      line.node.style.transform = `translateY(${(14 * (1 - Math.min(1, ramp(local, 0, 0.7)))).toFixed(1)}px)`;
    }
  };
}

/** A still, with a slow push-in. The only movement is the scale, so it cannot desync. */
function buildImage(spec, root) {
  const img = el("img", "clip", root);
  img.src = spec.src;
  return (t) => {
    const k = ease(ramp(t, 0, spec.dur));
    const scale = (spec.from ?? 1) + ((spec.to ?? 1.06) - (spec.from ?? 1)) * k;
    const originY = spec.originY ?? "18%";
    img.style.transformOrigin = `50% ${originY}`;
    img.style.transform = `scale(${scale.toFixed(4)})`;
    img.style.opacity = fade(t, spec.dur, 0.3, 0.3).toFixed(3);
  };
}

/**
 * A terminal shot. Three phases: the command types after the prompt, the cast plays, the last frame
 * holds. `plays` maps segment time onto cast time and is the only place a speed-ramp can exist; a
 * ramp with rate > 1 turns on the on-screen badge, because a viewer must be told that time was
 * compressed. Output is never skipped — a ramp changes the rate, never the range.
 */
async function buildTerminal(spec, root) {
  const cast = await json(`/casts/${spec.cast}.json`);
  const wrap = el("div", `term-wrap${V2 ? " native" : ""}`, root);
  const bar = el("div", "term-bar", wrap);
  const dots = el("div", "dots", bar);
  for (let i = 0; i < 3; i++) el("i", null, dots);
  if (V2) {
    // What a terminal window actually shows: the session, and nothing about how the footage was
    // made. The provenance that used to sit here (cast file, recording timestamp) moved into
    // docs/VIDEO.md and the closing card, which is where a claim belongs when it is about the video
    // rather than about the run.
    const title = el("div", "title", bar);
    title.textContent = `${cast.prompt.replace(/\s*[%$#]\s*$/, "").replace(" ~", ": ~")}`;
  } else {
    const who = el("div", "who", bar);
    who.textContent = `${cast.command}  —  exit ${cast.exitCode}`;
    const castTag = el("div", "cast", bar);
    castTag.textContent = `docs/evidence/casts/${cast.id}.json · recorded ${cast.recordedAt.slice(0, 19).replace("T", " ")}Z`;
  }
  const body = el("div", "term-body", wrap);

  const term = new Terminal({
    cols: cast.cols,
    // Two fewer rows in v2: its lower third is up to three lines tall, and a caption plate over the
    // last line of a run would cover the exit line that is the whole point of the shot.
    rows: spec.rows ?? (V2 ? 28 : 30),
    fontSize: spec.fontSize ?? 21,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    lineHeight: 1.15,
    cursorBlink: false, // a blinking cursor is wall-clock state; it would flicker across frames
    cursorStyle: "block",
    disableStdin: true,
    convertEol: false,
    scrollback: 0,
    theme: {
      background: "#111820",
      foreground: "#E9EFF5",
      cursor: "#3FD9C4",
      black: "#111820",
      red: "#F26D78",
      green: "#57B98A",
      yellow: "#E9C05A",
      blue: "#7FB3FF",
      magenta: "#C69BF0",
      cyan: "#3FD9C4",
      white: "#E9EFF5",
      brightBlack: "#5A7185",
      brightRed: "#F26D78",
      brightGreen: "#57B98A",
      brightYellow: "#E9C05A",
      brightBlue: "#7FB3FF",
      brightMagenta: "#C69BF0",
      brightCyan: "#3FD9C4",
      brightWhite: "#FFFFFF",
    },
  });
  term.open(body);
  term.focus();

  const command = spec.commandOverride ?? cast.command;
  const typeDur = spec.typeDur ?? Math.max(1.1, 0.055 * command.length);
  const settle = spec.settle ?? 0.45;

  // plays: [[castFromMs, castToMs, rate]] — contiguous, covering the whole cast by default.
  //
  // A bound may be negative (that many ms before the end of the cast) or `null` (the end), and a
  // rate may be `{fit: seconds}` (play this stretch in that many seconds, whatever its length).
  // Both exist so the edit does not hard-code a duration: `npm run verify` gets re-recorded and
  // takes a different number of seconds every time, and a stale ramp rate would either overrun the
  // segment or leave the last stage off screen. The edit says *how long the shot is*; the cast says
  // how long the run was; the rate falls out of the two.
  const end = cast.durationMs;
  const bound = (v) => (v === null || v === undefined ? end : v < 0 ? Math.max(0, end + v) : Math.min(v, end));
  const plays = (spec.plays ?? [[0, end, 1]]).map(([from, to, rate]) => {
    const f = bound(from);
    const t = bound(to);
    if (t < f) throw new Error(`${spec.cast}: play range ${from}→${to} is empty against a ${end}ms cast`);
    return { from: f, to: t, rate: typeof rate === "object" ? (t - f) / 1000 / rate.fit : (rate ?? 1) };
  });
  let cursor = typeDur + settle;
  for (const play of plays) {
    play.start = cursor;
    play.dur = (play.to - play.from) / 1000 / play.rate;
    cursor += play.dur;
    play.end = cursor;
  }
  const playEnd = cursor;
  const dur = spec.dur ?? playEnd + (spec.hold ?? 3);
  if (dur < playEnd - 0.001) {
    throw new Error(`${spec.cast}: dur ${dur}s is shorter than the run it must contain (${playEnd.toFixed(1)}s)`);
  }

  const ramps = plays.filter((p) => p.rate > 1);
  const badge = el("div", "ramp", root);

  // Zoom callouts, sliced out of the cast so they cannot misquote it.
  const flat = plain(cast.events.map(([, chunk]) => chunk).join(""));
  const zooms = (spec.zooms ?? []).map((z) => {
    const lines = flat.split("\n");
    const index = lines.findIndex((line) => line.includes(z.match));
    if (index < 0) throw new Error(`${spec.cast}: no line matching "${z.match}" — the cast changed`);
    const slice = lines.slice(index + (z.skip ?? 0), index + (z.skip ?? 0) + z.lines).join("\n");

    // v2's card has three parts and each is a different kind of statement, which is the point of the
    // redesign: a kicker naming what the viewer is being shown, the command's own bytes, and an
    // `explain` line that is editorial and is styled as editorial so it cannot be mistaken for
    // output. v1's callout was one accent-bordered box with a label, which read as decoration.
    const node = el("div", V2 ? `note note-${z.side ?? "left"}` : "zoom", root);
    if (V2) {
      const head = el("div", "note-head", node);
      if (z.label) {
        const kicker = el("span", "note-kicker", head);
        kicker.textContent = z.label;
      }
      const src = el("span", "note-src", head);
      src.textContent = z.source ?? `${cast.command}`;
      const pre = el("div", "note-quote", node);
      pre.textContent = slice.replace(/\s+$/, "");
      if (z.emphasise) pre.innerHTML = pre.innerHTML.replace(z.emphasise, (m) => `<em>${m}</em>`);
      if (z.fontSize) pre.style.fontSize = z.fontSize;
      if (z.explain) {
        const why = el("div", "note-explain", node);
        why.innerHTML = z.explain;
      }
      if (z.top) node.style.top = z.top;
      if (z.width) node.style.width = z.width;
      return { ...z, node };
    }

    if (z.label) {
      const label = el("span", "zoom-label", node);
      label.textContent = z.label;
    }
    const pre = el("span", null, node);
    pre.textContent = slice.replace(/\s+$/, "");
    if (z.emphasise) {
      pre.innerHTML = pre.innerHTML.replace(z.emphasise, (m) => `<em>${m}</em>`);
    }
    if (z.top) node.style.top = z.top;
    if (z.fontSize) node.style.fontSize = z.fontSize;
    return { ...z, node };
  });

  // Written state, so a forward seek only writes the delta.
  let writtenChars = 0; // of the typed command
  let writtenEvents = 0; // of the cast
  let promptReturned = false; // v2 only: the shell coming back after the run
  let lastT = -1;

  // The shell printing its prompt again is how a real terminal shows a command finished, and the
  // first cut had no equivalent: the footage simply stopped. It is the one string in the terminal
  // that the cast did not record, because `script` captures the child and not the interactive shell
  // that spawned it, so it is the cast's *own* prompt written a second time and nothing else. That a
  // prompt came back is not a claim beyond the recorded exit code, which every one of these shots
  // has at 0 (`npm run record:terminal` refuses to finish otherwise).
  const tail = cast.events.at(-1)?.[1] ?? "\n";
  const returnPrompt = (/[\r\n]$/.test(plain(tail)) ? "" : "\r\n") + cast.prompt;

  const flushWrite = (data) => new Promise((done) => term.write(data, done));

  const reset = async () => {
    term.reset();
    await flushWrite(cast.prompt);
    writtenChars = 0;
    writtenEvents = 0;
    promptReturned = false;
  };
  await reset();

  const castTimeAt = (t) => {
    if (t <= plays[0].start) return plays[0].from;
    for (const play of plays) {
      if (t < play.end) return play.from + (t - play.start) * play.rate * 1000;
    }
    return cast.durationMs + 1;
  };

  const render = async (t) => {
    if (t < lastT) await reset();
    lastT = t;

    const wantChars = Math.min(command.length, Math.floor((t / typeDur) * command.length));
    if (wantChars > writtenChars) {
      await flushWrite(command.slice(writtenChars, wantChars));
      writtenChars = wantChars;
    }
    if (t >= typeDur && writtenChars === command.length && writtenEvents === 0) {
      // The newline that starts the run: written once, with the first event.
    }

    const castT = castTimeAt(t);
    if (castT >= 0 && t >= typeDur + settle * 0.5) {
      let chunk = "";
      if (writtenEvents === 0) chunk += "\r\n";
      while (writtenEvents < cast.events.length && cast.events[writtenEvents][0] <= castT) {
        chunk += cast.events[writtenEvents][1];
        writtenEvents++;
      }
      if (chunk) await flushWrite(chunk);
      if (V2 && !promptReturned && writtenEvents === cast.events.length) {
        await flushWrite(returnPrompt);
        promptReturned = true;
      }
    }

    const active = ramps.find((p) => t >= p.start && t < p.end);
    badge.dataset.on = active ? "1" : "0";
    if (active) {
      const rate = active.rate.toFixed(active.rate < 10 ? 1 : 0);
      badge.textContent = V2 ? `⏩ ${rate}× · no output removed` : `⏩ ${rate}× — nothing removed, only sped up`;
    }

    for (const z of zooms) {
      // v2 snaps in over four frames and then holds absolutely still, which is what a cut-in
      // annotation does in an edited video. v1's slow continuous zoom across the whole hold is the
      // giveaway that no editor was involved: nothing in a human edit drifts for five seconds.
      const o = fade(t - z.at, z.dur, V2 ? 0.14 : 0.28, V2 ? 0.2 : 0.28);
      z.node.style.opacity = Math.max(0, o).toFixed(3);
      if (V2) {
        const k = ease(ramp(t - z.at, 0, 0.3));
        z.node.style.transform = `translateY(${(12 * (1 - k)).toFixed(1)}px) scale(${(0.99 + 0.01 * k).toFixed(4)})`;
      } else {
        const k = ease(ramp(t - z.at, 0, z.dur));
        z.node.style.transform = `translateX(-50%) scale(${(0.965 + 0.02 * k).toFixed(4)})`;
      }
    }
  };

  return { render, dur };
}

/** A code pane: the real file, a line range, some lines highlighted, a slow scroll. */
async function buildCode(spec, root) {
  const source = await text(`/repo/${spec.file}`);
  const lines = source.split("\n");
  const from = spec.from ?? 1;
  const to = Math.min(lines.length, spec.to ?? from + 30);
  const pane = el("div", "pane", root);
  const bar = el("div", "pane-bar", pane);
  bar.textContent = spec.file;
  const where = el("div", "where", bar);
  where.textContent = spec.note ?? `lines ${from}–${to}`;
  const scroll = el("div", "pane-scroll", pane);
  const code = el("div", "pane-code", scroll);
  const highlight = new Set(spec.highlight ?? []);
  for (let n = from; n <= to; n++) {
    const row = el("div", `row ${highlight.has(n) ? "hl" : ""}`, code);
    const num = el("div", "n", row);
    num.textContent = String(n);
    const t = el("div", "t", row);
    t.textContent = lines[n - 1] ?? "";
  }
  const rowH = 30;
  return (t) => {
    // Measured rather than assumed: the two cuts give the pane different heights, and a hard-coded
    // viewport would scroll one of them past its own last line.
    const visible = (scroll.clientHeight || 744) / rowH;
    const maxScroll = Math.max(0, (to - from + 1 - visible) * rowH);
    const k = ease(ramp(t, spec.scrollAt ?? 0.6, spec.dur - 0.5));
    const y = (spec.scrollFrom ?? 0) + ((spec.scrollTo ?? maxScroll) - (spec.scrollFrom ?? 0)) * k;
    code.style.transform = `translateY(${(-Math.min(y, maxScroll)).toFixed(1)}px)`;
    pane.style.opacity = fade(t, spec.dur, 0.3, 0.3).toFixed(3);
  };
}

/** A prose pane: markdown from the repo, rendered as blocks, so a doc can be read on screen. */
async function buildDoc(spec, root) {
  const source = await text(`/repo/${spec.file}`);
  const lines = source.split("\n").slice((spec.from ?? 1) - 1, spec.to ?? undefined);
  const pane = el("div", "pane", root);
  const bar = el("div", "pane-bar", pane);
  bar.textContent = spec.file;
  const where = el("div", "where", bar);
  where.textContent = spec.note ?? `lines ${spec.from}–${spec.to}`;
  const scroll = el("div", "pane-scroll", pane);
  const code = el("div", "pane-code prose", scroll);
  const blocks = [];
  for (const line of lines) {
    const row = el("div", "row", code);
    const t = el("div", "t", row);
    t.innerHTML = markdownish(line);
    blocks.push(row);
  }
  return (t) => {
    const k = ease(ramp(t, spec.scrollAt ?? 1.2, spec.dur - 0.6));
    const height = code.getBoundingClientRect().height;
    const maxScroll = Math.max(0, height - (scroll.clientHeight || 730));
    code.style.transform = `translateY(${(-maxScroll * k).toFixed(1)}px)`;
    pane.style.opacity = fade(t, spec.dur, 0.3, 0.3).toFixed(3);
  };
}

/** Just enough markdown for a doc pane: bold, inline code, headings, and nothing else. */
function markdownish(line) {
  const escaped = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/^(#+)\s*(.*)$/, (_, h, rest) => `<strong style="font-size:1.15em">${rest}</strong>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--color-text)">$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="font-family:ui-monospace,Menlo,monospace;color:var(--color-accent)">$1</code>');
}

/**
 * The dashboard clip, seeked frame-exactly rather than played.
 *
 * The frame is copied into a canvas rather than left in the `<video>` element, because a screenshot
 * of a `<video>` comes back black: the decoder hands frames to the compositor on its own schedule,
 * and this renderer screenshots between paints. `requestVideoFrameCallback` is the one signal that
 * says "a frame for the time you asked for is available now", so the sequence per frame is: seek,
 * wait for `seeked`, wait for the frame callback, then `drawImage`. The video element stays in the
 * page but invisible — a `display:none` ancestor would suspend decoding entirely.
 */
async function buildVideo(spec, root) {
  const canvas = el("canvas", "clip", root);
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d", { alpha: false });

  const video = el("video", "clip hidden-source", root);
  video.src = spec.src;
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  await new Promise((done, fail) => {
    video.onloadeddata = done;
    video.onerror = () => fail(new Error(`could not load ${spec.src}`));
  });

  const nextFrame = () =>
    new Promise((done) => {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(() => done());
        // A seek that lands on the frame already presented never fires the callback again, so this
        // needs a floor. It does not weaken determinism: `seeked` alone already guarantees the
        // frame at `currentTime` is decoded and drawable, and the callback is belt-and-braces.
        setTimeout(done, 120);
      } else {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }
    });

  const seekTo = (time) =>
    new Promise((done) => {
      if (Math.abs(video.currentTime - time) < 1 / (FPS * 8)) return done();
      video.onseeked = () => done();
      video.currentTime = time;
    });

  return async (t) => {
    const target = Math.max(0, Math.min(video.duration - 1 / FPS, (spec.from ?? 0) + t));
    await seekTo(target);
    await nextFrame();
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.style.opacity = fade(t, spec.dur, 0.25, 0.4).toFixed(3);
  };
}

/**
 * The agent transcript, replayed. Every turn's text is a line range of
 * `docs/evidence/phase7-transcript.md`, and the label naming that file is on screen for the whole
 * shot — this is a recorded exchange being replayed, not a live session, and the video says so
 * where a viewer can see it rather than in a footnote.
 */
async function buildChat(spec, root) {
  const source = await text(`/repo/${spec.file}`);
  const lines = source.split("\n");
  const pane = el("div", "chat", root);
  const inner = el("div", "chat-inner", pane);
  const label = el("div", "chat-label", pane);
  label.textContent = `recorded transcript · ${spec.file}`;

  const turns = spec.turns.map((turn) => {
    const node = el("div", `turn ${turn.who} ${turn.kind ?? ""} ${turn.transform === "table" ? "table" : ""}`, inner);
    const who = el("div", "who", node);
    who.textContent = turn.label ?? turn.who;
    const bodyNode = el("div", "body", node);
    const raw = lines.slice(turn.lines[0] - 1, turn.lines[1]).join("\n").trim();
    bodyNode.innerHTML = renderTurn(raw, turn);
    return { node, at: turn.at, typing: turn.typing };
  });

  return (t) => {
    for (const turn of turns) {
      turn.node.style.opacity = Math.min(1, ramp(t - turn.at, 0, 0.45)).toFixed(3);
      turn.node.style.transform = `translateY(${(10 * (1 - Math.min(1, ramp(t - turn.at, 0, 0.6)))).toFixed(1)}px)`;
    }
    // Scroll so the newest visible turn stays in frame, driven by t alone.
    const shown = turns.filter((turn) => t >= turn.at);
    const last = shown.at(-1);
    let y = 0;
    if (last) {
      const bottom = last.node.offsetTop + last.node.offsetHeight;
      y = Math.max(0, bottom - ((pane.clientHeight || 790) - 90));
    }
    inner.style.transform = `translateY(${(-y).toFixed(1)}px)`;
    pane.style.opacity = fade(t, spec.dur, 0.3, 0.3).toFixed(3);
  };
}

function renderTurn(raw, turn) {
  if (turn.transform === "heading") {
    return raw.replace(/^##\s*\d+\.\s*/, "");
  }
  if (turn.transform === "table") {
    // The citation tables carry a full subgraph id per row and are unreadable at video size, so the
    // subgraph column is reduced to the deployment names it lists. The values and blocks are the
    // file's own, untouched, and the pane bar says the table is condensed.
    const rows = raw.split("\n").filter((line) => line.startsWith("|"));
    const cells = rows.map((row) => row.split("|").slice(1, -1).map((c) => c.trim()));
    const body = cells
      .filter((row) => !/^-+$/.test(row[0] ?? ""))
      .map((row) => {
        const names = [...(row[2] ?? "").matchAll(/`([a-z0-9-]+-eth)`/g)].map((m) => m[1]);
        const block = (row[3] ?? "").split("<br>")[0];
        return `${(row[0] ?? "").padEnd(38)} ${(row[1] ?? "").padStart(16)}   ${
          names.length ? names.join(", ") : row[2]
        } @ ${block}`;
      })
      .join("\n");
    return escapeHtml(body);
  }
  if (turn.transform === "code") {
    return escapeHtml(raw.replace(/^```json\n?/, "").replace(/```$/, "").trim());
  }
  return markdownish(escapeHtml(raw).replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ─────────────────────────────────────────────────────────────────── assembly

const BUILDERS = {
  card: buildCard,
  image: buildImage,
  terminal: buildTerminal,
  code: buildCode,
  doc: buildDoc,
  video: buildVideo,
  chat: buildChat,
};

const segments = [];
let clock = 0;

for (const spec of EDIT.segments) {
  const root = el("div", "seg", stage);
  const built = await BUILDERS[spec.kind](spec, root);
  const render = typeof built === "function" ? built : built.render;
  const dur = typeof built === "function" ? spec.dur : built.dur;
  segments.push({ spec, root, render, start: clock, dur, end: clock + dur });
  clock += dur;
}

const captions = [];
for (const segment of segments) {
  for (const cue of segment.spec.captions ?? []) {
    captions.push({
      t0: segment.start + cue.at,
      t1: segment.start + cue.at + cue.dur,
      html: cue.html,
      // v2's cue is three registers rather than one sentence: `kicker` names the sponsor product
      // being used, `html` is the claim, and `detail` explains the mechanism for a judge who has
      // never touched this technology. See the head of edit.v2.mjs.
      kicker: cue.kicker,
      detail: cue.detail,
    });
  }
}
captions.sort((a, b) => a.t0 - b.t0);

const overlaps = captions.filter((c, i) => i > 0 && c.t0 < captions[i - 1].t1 - 0.001);
if (overlaps.length > 0) {
  throw new Error(`captions overlap: ${overlaps.map((c) => c.html.slice(0, 40)).join(" | ")}`);
}

const DURATION = clock;
let activeIndex = -1;

async function seek(t) {
  const clamped = Math.max(0, Math.min(DURATION - 1 / FPS, t));
  const index = segments.findIndex((s) => clamped >= s.start && clamped < s.end);
  const segment = segments[index === -1 ? segments.length - 1 : index];

  if (index !== activeIndex) {
    for (const [i, s] of segments.entries()) s.root.dataset.on = i === index ? "1" : "0";
    activeIndex = index;
  }
  await segment.render(clamped - segment.start);

  const cue = captions.find((c) => clamped >= c.t0 && clamped < c.t1);
  if (cue) {
    const key = `${cue.kicker ?? ""}|${cue.html}|${cue.detail ?? ""}`;
    if (captionBox.dataset.key !== key) {
      captionBox.innerHTML = V2
        ? (cue.kicker ? `<div class="cap-kicker">${cue.kicker}</div>` : "") +
          `<div class="cap-main">${cue.html}</div>` +
          (cue.detail ? `<div class="cap-detail">${cue.detail}</div>` : "")
        : cue.html;
      captionBox.dataset.key = key;
    }
    const local = clamped - cue.t0;
    captionBox.style.opacity = fade(local, cue.t1 - cue.t0, V2 ? 0.16 : 0.22, V2 ? 0.16 : 0.22).toFixed(3);
  } else {
    captionBox.style.opacity = "0";
  }

  const tag = segment.spec.track;
  trackTag.textContent = tag ?? "";
  trackTag.style.opacity = tag ? fade(clamped - segment.start, segment.dur, 0.5, 0.5).toFixed(3) : "0";

  progress.style.width = `${((clamped / DURATION) * 1920).toFixed(1)}px`;
}

await seek(0);

window.SENTINEL = {
  duration: DURATION,
  fps: FPS,
  seek,
  outline: segments.map((s) => ({
    kind: s.spec.kind,
    id: s.spec.id ?? s.spec.cast ?? s.spec.file ?? s.spec.src ?? "",
    start: Number(s.start.toFixed(2)),
    dur: Number(s.dur.toFixed(2)),
  })),
  cut: CUT,
  captions: captions.map((c) => ({
    t0: Number(c.t0.toFixed(2)),
    t1: Number(c.t1.toFixed(2)),
    kicker: c.kicker,
    html: c.html,
    detail: c.detail,
  })),
};
document.body.dataset.ready = "1";
