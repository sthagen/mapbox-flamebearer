import zlib from 'node:zlib';

export function parseTrace(buf) {
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const data = JSON.parse(buf.toString('utf8'));
    const events = data.traceEvents || data;

    const threadNames = new Map();
    const profiles = new Map();

    for (const e of events) {
        if (e.name === 'thread_name') {
            threadNames.set(`${e.pid}:${e.tid}`, e.args.name);

        } else if (e.name === 'Profile') {
            profiles.set(e.id, {
                key: `${e.pid}:${e.tid}`,
                startTime: e.args.data.startTime,
                nodes: new Map(),
                samples: [],
                timeDeltas: []
            });

        } else if (e.name === 'ProfileChunk') {
            const p = profiles.get(e.id);
            if (!p) continue;
            const {cpuProfile, timeDeltas} = e.args.data;
            if (cpuProfile.nodes) for (const n of cpuProfile.nodes) p.nodes.set(n.id, n);
            if (cpuProfile.samples) for (const s of cpuProfile.samples) p.samples.push(s);
            if (timeDeltas) for (const d of timeDeltas) p.timeDeltas.push(d);
        }
    }

    const threads = [];
    for (const p of profiles.values()) {
        threads.push(buildThread(p, threadNames.get(p.key) || p.key));
    }
    return {threads};
}

function buildThread(p, name) {
    const {nodes, samples, timeDeltas} = p;
    const selfByFrame = new Map();
    let busy = 0;
    let idle = 0;

    for (let i = 0; i < samples.length; i++) {
        const node = nodes.get(samples[i]);
        const dt = timeDeltas[i] || 0;
        if (!node) continue;

        const fname = node.callFrame.functionName;
        if (fname === '(idle)' || fname === '(program)') {
            idle += dt;
        } else {
            busy += dt;
            const key = frameKey(node.callFrame);
            const entry = selfByFrame.get(key);
            if (entry) entry.time += dt;
            else selfByFrame.set(key, {frame: node.callFrame, time: dt});
        }
    }

    const top = [...selfByFrame.values()].sort((a, b) => b.time - a.time);
    return {name, samples: samples.length, busy, idle, top};
}

function frameKey(f) {
    return `${f.functionName}|${f.url || ''}|${f.lineNumber || 0}|${f.columnNumber || 0}`;
}

export function formatFrame(f, shorten, paint) {
    const name = f.functionName || '(anonymous)';
    if (!f.url) return name;
    const loc = f.lineNumber >= 0 ? `:${f.lineNumber + 1}` : '';
    return `${name}  ${paint(`${shorten ? shorten(f.url) : f.url}${loc}`, 'dim')}`;
}

const ANSI = {bold: '1', dim: '2', red: '31', boldRed: '1;31'};
function makePainter(on) {
    return on ? (s, style) => `\x1b[${ANSI[style]}m${s}\x1b[0m` : s => s;
}

export function buildShortener(urlCounts, threshold = 0.8) {
    const byOrigin = new Map();
    for (const [url, count] of urlCounts) {
        const origin = parseOrigin(url);
        if (!origin) continue;
        const list = byOrigin.get(origin);
        if (list) list.push({url, count});
        else byOrigin.set(origin, [{url, count}]);
    }

    let dominant = null;
    let dominantWeight = 0;
    const prefixes = new Map();

    for (const [origin, list] of byOrigin) {
        const candidates = new Map();
        let total = 0;
        for (const {url, count} of list) {
            total += count;
            let i = url.indexOf('/', origin.length);
            while (i !== -1) {
                const prefix = url.slice(0, i + 1);
                candidates.set(prefix, (candidates.get(prefix) || 0) + count);
                i = url.indexOf('/', i + 1);
            }
        }
        const min = total * threshold;
        let best = `${origin}/`;
        for (const [prefix, w] of candidates) {
            if (w >= min && prefix.length > best.length) best = prefix;
        }
        prefixes.set(origin, best);
        if (total > dominantWeight) {
            dominantWeight = total;
            dominant = origin;
        }
    }

    const sources = [];
    for (const [origin, prefix] of prefixes) {
        const host = origin.replace(/^https?:\/\//, '');
        sources.push({tag: origin === dominant ? '' : host, prefix});
    }

    function shorten(url) {
        const origin = parseOrigin(url);
        if (!origin) return url;
        const prefix = prefixes.get(origin);
        const path = prefix && url.startsWith(prefix) ? url.slice(prefix.length) : url.slice(origin.length);
        return origin === dominant ? path : `[${origin.replace(/^https?:\/\//, '')}] ${path}`;
    }

    return {shorten, sources};
}

export function formatReport(trace, {top = 20, color = false} = {}) {
    const paint = makePainter(color);
    const hotThreshold = 5;

    const urlCounts = new Map();
    for (const t of trace.threads) {
        for (let i = 0; i < Math.min(top, t.top.length); i++) {
            const {url} = t.top[i].frame;
            if (url) urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
        }
    }
    const {shorten, sources} = buildShortener(urlCounts);

    const out = [];
    if (sources.length) {
        out.push(paint('Sources:', 'bold'));
        for (const {tag, prefix} of sources) {
            out.push(`  ${tag ? `[${tag}]`.padEnd(20) : ' '.repeat(20)}  ${paint(prefix, 'dim')}`);
        }
    }

    for (const t of trace.threads) {
        const busyMs = t.busy / 1000;
        const idleMs = t.idle / 1000;
        const totalUs = t.busy + t.idle;

        out.push('');
        out.push(paint(`=== ${t.name} ===`, 'bold'));
        out.push(`samples: ${t.samples}  busy: ${busyMs.toFixed(1)} ms  idle: ${idleMs.toFixed(1)} ms`);
        out.push('');
        out.push(paint('Top CPU (self time):', 'bold'));

        for (let i = 0; i < Math.min(top, t.top.length); i++) {
            const {frame, time} = t.top[i];
            const ms = (time / 1000).toFixed(1).padStart(7);
            const pctNum = totalUs > 0 ? 100 * time / totalUs : 0;
            const pct = pctNum.toFixed(1).padStart(4);
            const pctText = pctNum >= hotThreshold ? paint(`${pct}%`, 'boldRed') : `${pct}%`;
            out.push(`${ms} ms  ${pctText}  ${formatFrame(frame, shorten, paint)}`);
        }
    }

    return out.join('\n');
}

function parseOrigin(url) {
    if (!url) return null;
    const m = url.match(/^[a-z]+:\/\/[^/]+/);
    return m ? m[0] : null;
}
