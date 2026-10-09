"""The film's instruments (film/videopose.py) against the page's: sim-instruments.js stationView / loopFlags,
sim-lab-plan.js instrumentCaption and the sim-room.js LED, bar and loop colours, on one synthetic event log over
the lab's real stations and decor. No lab export, no GL: node runs the JS half, the film's Poser paints stand-in geoms."""

from __future__ import annotations

import json
import math
import os
import subprocess
from types import SimpleNamespace

import videopose

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))

LAB = json.load(open(os.path.join(STUDIO, "assets", "scenes", "lab", "scene.json")))
DECOR = json.load(open(os.path.join(STUDIO, "assets", "scenes", "lab", "decor.json")))
IDS = {s["id"] for s in LAB["stations"]}
# the sidecar's lab.anim LED and loop nodes, as labAnim builds them: geoms in item order
NODES = [dict(node=k, station=k.split(".")[0] if k.split(".")[0] in IDS else None, kind=a["kind"],
              geoms=[it["name"] for it in DECOR["items"] if k in ([it["anim"]] if isinstance(it.get("anim"), str) else it.get("anim") or [])],
              **{x: a[x] for x in ("colors", "blink_hz", "pulse_hz") if x in a})
         for k, a in DECOR["anim"].items() if a["kind"] in ("led", "loop")]
# one run: the handler busy once the puck leaves, the incubator cycle, then the reader's
EVENTS = [dict(station=s, state=x, t=t) for s, x, t in (
    ("lh", "running", 3.0), ("inc", "armed", 5.0), ("inc", "closing", 6.0), ("inc", "running", 6.8),
    ("inc", "opening", 10.8), ("inc", "done", 11.6), ("inc", "idle", 14.0), ("reader", "armed", 20.0),
    ("reader", "closing", 21.0), ("reader", "running", 21.6), ("reader", "opening", 24.6), ("reader", "done", 25.2))]
TIMES = sorted({round(0.013 + 0.05 * k, 6) for k in range(620)} | {e["t"] for e in EVENTS} | {e["t"] + 4e-4 for e in EVENTS})
# LED samples: t, then a station view's since and progress
SAMPLES = [(t, t % 4.5, min(1.0, (t % 4.5) / 4)) for t in TIMES]

JS = r"""
import { stationView, loopFlags, INST } from './src/features/sim-instruments.js';
import { instrumentCaption } from './src/features/sim-lab-plan.js';
import { BAR_RGB, OFF_RGB, LOOP_LEVEL, ledLevel, rgbeOf } from './src/ui/sim-room.js';
const [lab, events, times, nodes, samples] = process.argv.slice(1).map((a) => JSON.parse(a));
const first = (pred) => { const e = events.find(pred); return e ? e.t : null; };
const views = times.map((t) => {
  const stations = {};
  for (const S of lab.stations) {
    let [t0, state] = [0, S.start || 'idle'];
    for (const e of events) if (e.station === S.id && e.t <= t + 1e-9 && e.t >= t0) [t0, state] = [e.t, e.state];
    stations[S.id] = stationView(S, state, t0, t);
  }
  const seen = (x) => (x != null && x <= t + 1e-9 ? x : null);
  const loop = loopFlags(t, { testOn: seen(first((e) => e.station === 'inc' && e.state === 'closing')),
    readDone: seen(first((e) => e.station === 'reader' && e.state === 'done')),
    buildOff: seen(first((e) => e.station === 'lh' && e.state === 'running')) });
  return { stations, loop, caption: instrumentCaption(stations) };
});
/* each LED geom's rgbe per state and sample, as applyInstruments tints it; each loop light's off and on */
const led = {}, loopRgbe = {};
for (const n of nodes) {
  if (n.kind === 'led') led[n.node] = Object.fromEntries(Object.keys(n.colors).map((s) => [s, samples.map(([t, since, progress]) =>
    n.geoms.map((g) => rgbeOf(n.colors[s], ledLevel(n, { state: s, since, progress }, t, g))))]));
  else loopRgbe[n.node] = ['off', 'on'].map((k) => rgbeOf(n.colors[k], ...LOOP_LEVEL[k]));
}
console.log(JSON.stringify({ views, led, loopRgbe, BAR_RGB, OFF_RGB, designDelayS: INST.designDelayS }));
"""


def js():
    r = subprocess.run(["node", "--input-type=module", "-e", JS, json.dumps(LAB), json.dumps(EVENTS), json.dumps(TIMES),
                        json.dumps(NODES), json.dumps(SAMPLES)], cwd=STUDIO, check=True, capture_output=True, text=True, timeout=120)
    return json.loads(r.stdout)


J = None


def page():
    global J
    J = J or js()
    return J


def test_station_views_and_loop_match():
    tl = videopose.Timeline(LAB, EVENTS)
    n = 0
    for t, v in zip(TIMES, page()["views"]):
        st, loop = tl.at(t)
        assert [loop[k] for k in videopose.LOOP] == v["loop"], (t, loop, v["loop"])
        for sid, o in st.items():
            w = v["stations"][sid]
            assert o["state"] == w["state"], (t, sid)
            assert abs(o["since"] - w["since"]) < 6e-4 and abs(o["closure"] - w["closure"]) < 1e-4, (t, sid, o, w)
            assert abs(o["progress"] - w["progress"]) < 1e-4, (t, sid, o, w)
            assert ("remaining" in o) == ("remaining" in w), (t, sid)
            if "remaining" in o:
                assert abs(o["remaining"] - w["remaining"]) < 5.1e-3, (t, sid)
            assert ("bars" in o) == ("bars" in w), (t, sid)
            for a, b in zip(o.get("bars", []), w.get("bars", [])):
                assert abs(a - b) < 1e-4, (t, sid, o["bars"], w["bars"])
            n += 1
    assert n == 3 * len(TIMES)
    states = {(sid, s["state"]) for v in page()["views"] for sid, s in v["stations"].items()}
    assert len(states) >= 12, sorted(states)                        # every phase of both cycles was sampled


def test_captions_match():
    """each side captions its own view; the page rounds `remaining` to 0.01 s before its 0.1 s, so times whose
    remaining sits within 6 ms of a 0.05 s boundary are left out"""
    tl, said = videopose.Timeline(LAB, EVENTS), set()
    for t, v in zip(TIMES, page()["views"]):
        st, _ = tl.at(t)
        r = [o["remaining"] for o in st.values() if "remaining" in o]
        if r and abs((r[0] * 20) % 1 - 0.5) > 0.5 - 0.12:
            continue
        assert videopose.caption(st) == v["caption"], (t, videopose.caption(st), v["caption"])
        said.add(v["caption"].split(" · ")[0])
    assert len(said) >= 7, said


def test_design_delay_is_inst():
    tl = videopose.Timeline(LAB, EVENTS)
    d = page()["designDelayS"]
    assert not tl.at(tl.read + d - 1e-3)[1]["design"] and tl.at(tl.read + d)[1]["design"]


def film_paint(node, st, loop, t):
    """the film's Poser over stand-in geoms for one node: [[r, g, b, emission]] per geom"""
    names = node["geoms"]
    m = SimpleNamespace(ngeom=len(names), geom=lambda i: SimpleNamespace(name=names[i]))
    mj = SimpleNamespace(mjtObj=SimpleNamespace(mjOBJ_GEOM=5))
    P = videopose.Poser(mj, m, {"anim": [node], "stations": LAB["stations"]})
    geoms = [SimpleNamespace(objid=i, objtype=5, rgba=[0.0] * 4, emission=-1.0) for i in range(len(names))]
    P.apply(SimpleNamespace(ngeom=len(names), geoms=geoms), st, loop, t)
    return [[*g.rgba[:3], g.emission] for g in geoms]


def close(a, b):
    return all(math.isclose(x, y, abs_tol=1e-12) for x, y in zip(a, b)) and len(a) == len(b)


def test_bar_colours_match():
    J = page()
    assert [list(c) for c in videopose.CAPS] == J["BAR_RGB"]
    assert list(videopose.LED["off"]) == J["OFF_RGB"]


def test_loop_lights_match():
    J = page()
    for n in NODES:
        if n["kind"] != "loop":
            continue
        for on, k in ((False, 0), (True, 1)):
            film = film_paint(n, {}, {x: on for x in videopose.LOOP}, 0.0)
            for g in film:
                assert close(g, J["loopRgbe"][n["node"]][k]), (n["node"], on, g, J["loopRgbe"][n["node"]][k])


def test_led_colours_match():
    """every LED geom in every coloured state: blink, pulse, the incubator ring's fill, steady"""
    J, seen = page(), set()
    for n in NODES:
        if n["kind"] != "led":
            continue
        for s in n["colors"]:
            for (t, since, progress), page_g in zip(SAMPLES, J["led"][n["node"]][s]):
                film = film_paint(n, {n["station"]: dict(state=s, since=since, progress=progress)}, {}, t)
                for g, f, p in zip(n["geoms"], film, page_g):
                    assert close(f, p), (n["node"], g, s, t, f, p)
                    seen.add((g, s, round(f[3] / 0.9, 2)))
    lv = lambda g, s: {k for gg, ss, k in seen if (gg, ss) == (g, s)}
    assert lv("anim_inc_led_0", "armed") == {1.0, 0.25}                      # the blink
    assert len(lv("anim_inc_led_0", "running")) > 20                         # the pulse
    assert len(lv("anim_inc_ring_0", "running")) > 20 and min(lv("anim_inc_ring_0", "running")) == 0.3  # the fill
    assert lv("anim_inc_ring_0", "closing") == lv("anim_inc_led_0", "closing")
