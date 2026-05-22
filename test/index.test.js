import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {TraceMap} from '@jridgewell/trace-mapping';
import {parseInput, parseTrace, parseCpuProfile, buildShortener, formatReport, resolveSourceMaps, findStacks} from '../index.js';

const tinyCpuProfile = {
    nodes: [
        {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1}},
        {id: 2, callFrame: {functionName: '(idle)', url: '', lineNumber: -1, columnNumber: -1}},
        {id: 3, callFrame: {functionName: 'foo', url: 'file:///app/a.js', lineNumber: 10, columnNumber: 0}},
        {id: 4, callFrame: {functionName: 'bar', url: 'file:///app/b.js', lineNumber: 20, columnNumber: 0}}
    ],
    samples: [3, 3, 4, 2, 3],
    timeDeltas: [1000, 2000, 3000, 500, 1000],
    startTime: 0,
    endTime: 7500
};

test('parseInput dispatches by payload shape', () => {
    const cpuBuf = Buffer.from(JSON.stringify(tinyCpuProfile));
    const r = parseInput(cpuBuf, 'foo.cpuprofile');
    assert.equal(r.source, 'cpuprofile');
    assert.equal(r.threads.length, 1);
    assert.equal(r.threads[0].name, 'foo');

    const traceBuf = Buffer.from(JSON.stringify({traceEvents: []}));
    const r2 = parseInput(traceBuf, 'x.json');
    assert.equal(r2.source, 'chrome');
});

test('parseCpuProfile aggregates self time and splits idle', () => {
    const t = parseCpuProfile(tinyCpuProfile, 'name');
    assert.equal(t.name, 'name');
    assert.equal(t.idle, 500); // sample 4 is (idle), dt 500
    assert.equal(t.busy, 1000 + 2000 + 3000 + 1000);
    const foo = t.top.find(e => e.frame.functionName === 'foo');
    const bar = t.top.find(e => e.frame.functionName === 'bar');
    assert.equal(foo.time, 1000 + 2000 + 1000);
    assert.equal(bar.time, 3000);
    assert.equal(t.top[0].frame.functionName, 'foo'); // sorted desc
});

test('parseTrace links Profile + ProfileChunk and finds long tasks', () => {
    const events = [
        {name: 'thread_name', pid: 1, tid: 2, args: {name: 'Main'}},
        {name: 'Profile', id: '0xp', pid: 1, tid: 2, args: {data: {startTime: 0}}},
        {name: 'ProfileChunk', id: '0xp', pid: 1, tid: 2, args: {data: {
            cpuProfile: {
                nodes: [
                    {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1}},
                    {id: 2, callFrame: {functionName: 'hot', url: 'a.js', lineNumber: 0, columnNumber: 0}}
                ],
                samples: [2, 2, 2]
            },
            timeDeltas: [10000, 20000, 30000]
        }}},
        {ph: 'X', name: 'RunTask', pid: 1, tid: 2, ts: 0, dur: 60000, cat: 'devtools.timeline'},
        {ph: 'X', name: 'V8.GC_SCAVENGER', pid: 1, tid: 2, ts: 5000, dur: 1000, cat: 'v8'}
    ];
    const r = parseTrace({traceEvents: events});
    assert.equal(r.threads.length, 1);
    const t = r.threads[0];
    assert.equal(t.name, 'Main');
    assert.equal(t.longTasks.length, 1);
    assert.equal(t.longTasks[0].dominant.functionName, 'hot');
    const gc = t.breakdown.find(b => b.category === 'gc');
    assert.ok(gc && gc.time === 1000);
});

test('buildShortener picks dominant origin and tags others', () => {
    const counts = new Map([
        ['https://main.example.com/a/x.js', 5],
        ['https://main.example.com/a/y.js', 5],
        ['https://other.example.com/z.js', 1]
    ]);
    const {shorten, sources} = buildShortener(counts);
    assert.equal(shorten('https://main.example.com/a/x.js'), 'x.js');
    assert.equal(shorten('https://other.example.com/z.js'), '[other.example.com] z.js');
    assert.ok(sources.some(s => s.tag === '' && s.prefix === 'https://main.example.com/a/'));
    assert.ok(sources.some(s => s.tag === 'other.example.com'));
});

test('buildShortener handles file:// (empty host)', () => {
    const counts = new Map([
        ['file:///Users/x/proj/a.js', 3],
        ['file:///Users/x/proj/b.js', 3]
    ]);
    const {shorten} = buildShortener(counts);
    assert.equal(shorten('file:///Users/x/proj/a.js'), 'a.js');
});

test('buildShortener tags chrome-extension with truncated id', () => {
    const counts = new Map([
        ['https://page.example.com/a.js', 10],
        ['chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/injected.js', 2]
    ]);
    const {shorten} = buildShortener(counts);
    assert.match(shorten('chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline/injected.js'), /^\[ext:aeblfd\]/);
});

test('resolveSourceMaps remaps frames via injected loader', () => {
    const map = new TraceMap({
        version: 3,
        sources: ['../src/index.ts'],
        names: ['myFunc'],
        mappings: 'AAAAA'
    }, 'file:///bundle/foo.js.map');
    const load = url => (url === 'file:///bundle/foo.js' ? map : null);

    const trace = {threads: [{
        top: [{frame: {functionName: '(anonymous)', url: 'file:///bundle/foo.js', lineNumber: 0, columnNumber: 0}, time: 100}],
        longTasks: [{ts: 0, dur: 0, dominant: {functionName: 'x', url: 'file:///bundle/foo.js', lineNumber: 0, columnNumber: 0}}]
    }]};
    resolveSourceMaps(trace, {load});

    const f = trace.threads[0].top[0].frame;
    assert.match(f.url, /index\.ts$/);
    assert.equal(f.lineNumber, 0);
    assert.equal(f.functionName, 'myFunc');

    const lt = trace.threads[0].longTasks[0].dominant;
    assert.match(lt.url, /index\.ts$/);
    assert.equal(lt.functionName, 'x'); // not anonymous, name preserved
});

test('parseTrace collects embedded sourcemaps from metadata; resolveSourceMaps applies them', () => {
    const data = {
        metadata: {
            sourceMaps: [{
                url: 'http://example.com/dist/bundle.js',
                sourceMapUrl: 'http://example.com/dist/bundle.js.map',
                sourceMap: {version: 3, sources: ['../src/index.ts'], names: ['myFunc'], mappings: 'AAAAA'}
            }]
        },
        traceEvents: [
            {name: 'Profile', id: '0xp', pid: 1, tid: 2, args: {data: {startTime: 0}}},
            {name: 'ProfileChunk', id: '0xp', pid: 1, tid: 2, args: {data: {
                cpuProfile: {
                    nodes: [
                        {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1}},
                        {id: 2, callFrame: {functionName: '(anonymous)', url: 'http://example.com/dist/bundle.js', lineNumber: 0, columnNumber: 0}}
                    ],
                    samples: [2]
                },
                timeDeltas: [1000]
            }}}
        ]
    };

    const trace = parseTrace(data);
    assert.ok(trace.embeddedMaps.has('http://example.com/dist/bundle.js'));

    resolveSourceMaps(trace);
    const f = trace.threads[0].top[0].frame;
    // resolved against the bundle URL so the shortener can collapse origins later
    assert.equal(f.url, 'http://example.com/src/index.ts');
    assert.equal(f.functionName, 'myFunc');
});

test('resolveSourceMaps picks up inline data-URL maps from source files', () => {
    const tmp = fs.mkdtempSync('/tmp/fb-sm-');
    const jsPath = `${tmp}/bundle.js`;
    const rawMap = JSON.stringify({version: 3, sources: ['../src/index.ts'], names: ['myFunc'], mappings: 'AAAAA'});
    const b64 = Buffer.from(rawMap).toString('base64');
    fs.writeFileSync(jsPath, `function a(){}\n//# sourceMappingURL=data:application/json;base64,${b64}\n`);

    const trace = {threads: [{
        top: [{frame: {functionName: '(anonymous)', url: `file://${jsPath}`, lineNumber: 0, columnNumber: 0}, time: 100}]
    }]};
    resolveSourceMaps(trace);

    const f = trace.threads[0].top[0].frame;
    assert.match(f.url, /index\.ts$/);
    assert.equal(f.functionName, 'myFunc');
    fs.rmSync(tmp, {recursive: true});
});

test('findStacks aggregates callers and callees of matching frames', () => {
    // tree: root -> outer -> mid -> leafA (sampled)
    //                    -> leafB (sampled)
    //       root -> other -> mid -> leafA (sampled, second call site for mid)
    const profile = {
        nodes: [
            {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1}, children: [2, 6]},
            {id: 2, callFrame: {functionName: 'outer', url: 'a.js', lineNumber: 0, columnNumber: 0}, children: [3]},
            {id: 3, callFrame: {functionName: 'mid',   url: 'a.js', lineNumber: 1, columnNumber: 0}, children: [4, 5]},
            {id: 4, callFrame: {functionName: 'leafA', url: 'a.js', lineNumber: 2, columnNumber: 0}},
            {id: 5, callFrame: {functionName: 'leafB', url: 'a.js', lineNumber: 3, columnNumber: 0}},
            {id: 6, callFrame: {functionName: 'other', url: 'a.js', lineNumber: 4, columnNumber: 0}, children: [7]},
            {id: 7, callFrame: {functionName: 'mid',   url: 'a.js', lineNumber: 1, columnNumber: 0}, children: [8]},
            {id: 8, callFrame: {functionName: 'leafA', url: 'a.js', lineNumber: 2, columnNumber: 0}}
        ],
        samples: [4, 5, 8, 3], // leafA, leafB, leafA (other path), mid self
        timeDeltas: [1000, 2000, 4000, 500],
        startTime: 0
    };
    const t = parseCpuProfile(profile, 'tt');
    const groups = findStacks(t, 'mid');

    // Both mid nodes (id 3 and id 7) share the same frame identity (same file/line/col),
    // so they merge into one group with sites=2.
    assert.equal(groups.length, 1);
    const g = groups[0];
    assert.equal(g.sites, 2);
    assert.equal(g.self, 500);                       // only sample[3] hits a mid node directly
    assert.equal(g.total, 1000 + 2000 + 4000 + 500); // all descendants + mid's own self

    const callers = Object.fromEntries(g.callers.map(c => [c.frame.functionName, c.time]));
    assert.equal(callers.outer, 1000 + 2000 + 500); // mid(id 3) total: leafA + leafB + self
    assert.equal(callers.other, 4000);              // mid(id 7) total: leafA only

    const callees = Object.fromEntries(g.callees.map(c => [c.frame.functionName, c.time]));
    assert.equal(callees.leafA, 1000 + 4000);
    assert.equal(callees.leafB, 2000);

    // Hot path is a tree: aggregates descendants by frame identity across all matching call
    // sites, branches into every child above the threshold. leafA (5000us across mid(3)+mid(7))
    // and leafB (2000us under mid(3)) both clear the 5% cutoff of g.total (7500us).
    assert.equal(g.hotPath.length, 2);
    assert.equal(g.hotPath[0].frame.functionName, 'leafA');
    assert.equal(g.hotPath[0].time, 5000);
    assert.equal(g.hotPath[1].frame.functionName, 'leafB');
    assert.equal(g.hotPath[1].time, 2000);
    assert.equal(g.hotPath[0].children.length, 0);

    // Exact match is case-insensitive; substring no longer matches.
    assert.equal(findStacks(t, 'MID').length, 1);
    assert.deepEqual(findStacks(t, 'mi'), []);
    assert.deepEqual(findStacks(t, 'nonexistent'), []);
});

test('findStacks splits same-named functions in different files into separate groups', () => {
    const profile = {
        nodes: [
            {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1}, children: [2, 4]},
            {id: 2, callFrame: {functionName: 'caller1', url: 'a.js', lineNumber: 0, columnNumber: 0}, children: [3]},
            {id: 3, callFrame: {functionName: 'draw',    url: 'foo.js', lineNumber: 10, columnNumber: 0}},
            {id: 4, callFrame: {functionName: 'caller2', url: 'b.js', lineNumber: 0, columnNumber: 0}, children: [5]},
            {id: 5, callFrame: {functionName: 'draw',    url: 'bar.js', lineNumber: 20, columnNumber: 0}}
        ],
        samples: [3, 5],
        timeDeltas: [1000, 4000],
        startTime: 0
    };
    const t = parseCpuProfile(profile, 'tt');
    const groups = findStacks(t, 'draw');
    assert.equal(groups.length, 2);
    // Sorted by total time desc.
    assert.equal(groups[0].frame.url, 'bar.js');
    assert.equal(groups[0].total, 4000);
    assert.equal(groups[0].callers[0].frame.functionName, 'caller2');
    assert.equal(groups[1].frame.url, 'foo.js');
    assert.equal(groups[1].callers[0].frame.functionName, 'caller1');
});

test('findStacks handles Chrome ProfileChunk nodes (parent field, no children arrays)', () => {
    // Same shape as the cpuprofile test above but using `parent` instead of `children`,
    // matching what Chrome embeds in ProfileChunk events.
    const events = [
        {name: 'Profile', id: '0xp', pid: 1, tid: 2, args: {data: {startTime: 0}}},
        {name: 'ProfileChunk', id: '0xp', pid: 1, tid: 2, args: {data: {
            cpuProfile: {
                nodes: [
                    {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1}},
                    {id: 2, callFrame: {functionName: 'outer', url: 'a.js', lineNumber: 0, columnNumber: 0}, parent: 1},
                    {id: 3, callFrame: {functionName: 'mid',   url: 'a.js', lineNumber: 1, columnNumber: 0}, parent: 2},
                    {id: 4, callFrame: {functionName: 'leaf',  url: 'a.js', lineNumber: 2, columnNumber: 0}, parent: 3}
                ],
                samples: [4, 4]
            },
            timeDeltas: [1000, 2000]
        }}}
    ];
    const trace = parseTrace({traceEvents: events});
    const groups = findStacks(trace.threads[0], 'mid');
    assert.equal(groups.length, 1);
    const g = groups[0];
    assert.equal(g.sites, 1);
    assert.equal(g.total, 3000); // includes leaf's 3000us via children inverted from parent
    assert.equal(g.callers[0].frame.functionName, 'outer');
    assert.equal(g.callers[0].time, 3000);
    assert.equal(g.callees[0].frame.functionName, 'leaf');
    assert.equal(g.callees[0].time, 3000);
});

test('formatReport runs on both fixture types and includes key sections', () => {
    const cpuBuf = fs.readFileSync('test/fixtures/CPU.20260521.185552.92535.0.001.cpuprofile');
    const traceBuf = fs.readFileSync('test/fixtures/Trace-20260521T190407.json.gz');

    const cpuReport = formatReport(parseInput(cpuBuf, 'test/fixtures/CPU.20260521.185552.92535.0.001.cpuprofile'));
    assert.match(cpuReport, /Top CPU \(self time\):/);

    const traceReport = formatReport(parseInput(traceBuf, 'test/fixtures/Trace-20260521T190407.json.gz'));
    assert.match(traceReport, /=== CrRendererMain ===/);
    assert.match(traceReport, /Top CPU \(self time\):/);
});
