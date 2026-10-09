"""The hero edit over one continuous run clock: lower-third captions, a robot-camera inset with a webcam
look, grain / vignette / lateral CA on the camera image, and the title and end cards. The tracks
("pip", "captions", "cards") live in shots.json; their times resolve as the shots' do (videoshots.Times).

Output frame j: the title card for j < n_title, then run frame j - n_title, then the end card.
"""

from __future__ import annotations

import collections
import io
import math
import os

import numpy as np

from videoshots import Times, smooth

FONT_ROOT = "/usr/share/fonts/truetype"
FACES = {"bold": ("lato/Lato-Bold.ttf", "noto/NotoSans-Bold.ttf", "dejavu/DejaVuSans-Bold.ttf"),
         "semi": ("lato/Lato-Semibold.ttf", "noto/NotoSans-Bold.ttf", "dejavu/DejaVuSans-Bold.ttf"),
         "reg": ("lato/Lato-Regular.ttf", "noto/NotoSans-Regular.ttf", "dejavu/DejaVuSans.ttf")}
LUM = np.array([0.2126, 0.7152, 0.0722], np.float32)
WEBCAM = (640, 480)
PIP_W = 0.22                    # inset width / frame width
FADE = 0.35                     # s, captions and the inset
GRAIN = 0.012                   # luma sigma at mid-grey
VIGNETTE_EV = -0.3
CA_PX = 0.5                     # lateral CA at the corners


def font(face, px):
    from PIL import ImageFont
    for rel in FACES[face]:
        p = os.path.join(FONT_ROOT, rel)
        if os.path.exists(p):
            return ImageFont.truetype(p, px)
    return ImageFont.load_default()


_R2 = {}


def radius2(w, h):
    """squared radius, 1 at the corners"""
    if (w, h) in _R2:
        return _R2[(w, h)]
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    _R2[(w, h)] = ((x - (w - 1) / 2) ** 2 + (y - (h - 1) / 2) ** 2) / (((w - 1) / 2) ** 2 + ((h - 1) / 2) ** 2)
    return _R2[(w, h)]


def webcam(px, name, t, i):
    """a raw 640x480 USB-camera frame: lower dynamic range, auto-WB drift, soft dark corners, sensor
    noise, MJPEG at q 80"""
    from PIL import Image, ImageFilter
    im = Image.fromarray(px)
    if im.size != WEBCAM:
        im = im.resize(WEBCAM, Image.LANCZOS)
    x = np.asarray(im, np.float32) / 255
    ph = {"front": 0.0, "wrist": 2.1, "top": 4.2}.get(name, 0.0)
    drift = 0.03 * math.sin(2 * math.pi * t / 11.0 + ph)
    x = x * np.array([1 + drift, 1 + 0.3 * drift, 1 - drift], np.float32)
    x = 0.05 + 0.87 * (1 - np.exp(-1.7 * x)) / (1 - math.exp(-1.7))
    L = x @ LUM
    x = L[..., None] + 0.85 * (x - L[..., None])
    r2 = radius2(*WEBCAM)[..., None] ** 2
    soft = np.asarray(Image.fromarray(np.uint8(np.clip(x, 0, 1) * 255)).filter(ImageFilter.GaussianBlur(1.8)), np.float32) / 255
    x = (x * (1 - 0.8 * r2) + soft * 0.8 * r2) * (1 - 0.3 * r2)
    rng = np.random.default_rng(7919 * i + len(name))
    x = x + rng.standard_normal(x.shape[:2], np.float32)[..., None] * 0.014 + rng.standard_normal(x.shape, np.float32) * 0.008
    buf = io.BytesIO()
    Image.fromarray(np.uint8(np.clip(x, 0, 1) * 255 + 0.5)).save(buf, "JPEG", quality=80)
    return np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB"))


class Edit:
    def __init__(self, doc, run, lab, W=1920, H=1080, fps=30, look=True, draft=False, cards=True):
        self.W, self.H, self.fps, self.look, self.draft = W, H, fps, look, draft
        T = self.T = Times(run)
        self.pips = [(T(p["t"][0]), T(p["t"][1]), p["cam"]) for p in doc.get("pip", [])]
        self.caps = [(T(c["t"][0]), T(c["t"][1]), c.get("kicker", ""), c["text"], c.get("clock")) for c in doc.get("captions", [])]
        st = {s["id"]: s for s in (lab or {}).get("stations", [])}
        cy = (st.get("inc") or {}).get("cycle") or {"run": 4}
        ed = doc.get("edit") or {}
        self.modelled_s = 60.0 * float(ed.get("incubation_min", 30))
        self.inc_run = (T("inc:running") if "inc:running" in T.event else None, float(cy["run"]))
        self.vars = dict(x="%d" % round(self.modelled_s / self.inc_run[1]), modelled="%d" % round(self.modelled_s / 60),
                         run="%g" % self.inc_run[1], len="%.1f" % T.end)
        cd = doc.get("cards") or {}
        self.cards = cd if cards else {}
        self.n_title = int(round(float(cd.get("title", {}).get("s", 0)) * fps)) if cards else 0
        self.n_end = int(round(float(cd.get("end", {}).get("s", 0)) * fps)) if cards else 0
        self.fade = (float(ed.get("fade_in_s", 0.6)), T(ed.get("fade_out", "end")), float(ed.get("fade_out_s", 0.6)))
        self.pip_size = (int(W * PIP_W) // 2 * 2, int(W * PIP_W * 3 / 4) // 2 * 2)
        self.pip_xy = (W - self.pip_size[0] - int(0.025 * W), H - self.pip_size[1] - int(0.045 * H))
        u = H / 1080.0
        self.u = u
        self.f_kick, self.f_cap, self.f_sub = font("bold", round(19 * u)), font("semi", round(42 * u)), font("reg", round(26 * u))
        self.f_tag, self.f_clock = font("bold", round(15 * u)), font("reg", round(21 * u))
        self.f_title, self.f_title2 = font("semi", round(66 * u)), font("reg", round(32 * u))
        self.vig = ((2.0 ** (VIGNETTE_EV * radius2(W, H))) ** (1 / 2.2)).astype(np.float32)
        self.scrim = None

    def run_frames(self, n):
        return self.n_title + n + self.n_end

    def pip_at(self, t):
        """(camera name, opacity) of the inset at t, or None"""
        for a, b, cam in self.pips:
            if a <= t < b:
                return cam, smooth(min(t - a, b - t) / FADE)
        return None

    def captions_at(self, t):
        out = []
        for a, b, kick, text, clock in self.caps:
            if a <= t < b:
                line2 = self.clock(t) if clock == "incubation" else ""
                out.append((kick, text.format(**self.vars), line2, smooth(min(t - a, b - t) / FADE)))
        return out

    def stamp(self, t):
        """the corner clock: run time and the playback rate (the incubator's while it is compressed)"""
        t0, run = self.inc_run
        rate = "×" + self.vars["x"] if t0 is not None and t0 <= t < t0 + run else "1×"
        return "%05.2f s  ·  %s" % (t, rate)

    def clock(self, t):
        t0, run = self.inc_run
        if t0 is None:
            return ""
        s = self.modelled_s * min(1.0, max(0.0, (t - t0) / run))
        return "modelled time %02d:%02d / %02d:00" % (s // 60, s % 60, self.modelled_s // 60)

    def film(self, img, i):
        """lateral CA, vignette and luminance-weighted grain, after the tonemap"""
        from PIL import Image
        if self.look:
            im = Image.fromarray(img)
            r, g, b = im.split()
            cx, cy = (self.W - 1) / 2, (self.H - 1) / 2
            k = CA_PX / math.hypot(cx, cy)

            def scale(ch, s):
                return ch.transform(ch.size, Image.AFFINE, (1 / s, 0, cx * (1 - 1 / s), 0, 1 / s, cy * (1 - 1 / s)),
                                    Image.BILINEAR)
            img = np.asarray(Image.merge("RGB", (scale(r, 1 + k), g, scale(b, 1 - k))))
        x = img.astype(np.float32) * (self.vig[..., None] / 255)
        if self.look:
            rng = np.random.default_rng(104729 + i)
            L = x @ LUM
            w = np.clip(4 * L * (1 - L), 0.15, 1.0)
            n = rng.standard_normal(L.shape, np.float32) * GRAIN
            c = rng.standard_normal((self.H // 2, self.W // 2, 3), np.float32) * (GRAIN / 3)
            x = x + (n * w)[..., None] + np.repeat(np.repeat(c, 2, 0), 2, 1)[:self.H, :self.W] * w[..., None]
        return np.uint8(np.clip(x, 0, 1) * 255 + 0.5)

    def _scrim(self):
        if self.scrim is None:
            from PIL import Image
            h = int(0.34 * self.H)
            a = (np.linspace(0, 1, h, dtype=np.float32) ** 1.6 * 0.5 * 255).astype(np.uint8)
            self.scrim = Image.fromarray(np.repeat(a[:, None], self.W, 1), "L")
        return self.scrim

    def compose(self, main, t, i, pip=None, shot=None):
        """one run frame: the film look on `main`, then the fade, the inset (name, 640x480 px) and captions;
        shot = (id, lens, f-stop) labels a draft. Every overlay is drawn opaque on its own RGBA layer and
        composited at its opacity, so text fades with its chip, scrim and inset."""
        from PIL import Image, ImageDraw
        img = self.film(main, i)
        fi, fo, fs = self.fade
        k = smooth(t / fi) * (1 - smooth((t - (fo - fs)) / fs))
        if k < 1:
            img = np.uint8(img * k + 0.5)
        im = Image.fromarray(img).convert("RGBA")
        P = lambda v: int(round(v * self.u))  # noqa: E731

        def layer(alpha, draw):
            if alpha <= 0:
                return
            ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
            draw(ImageDraw.Draw(ov))
            if alpha < 1:
                ov.putalpha(ov.getchannel("A").point(lambda v: int(v * alpha + 0.5)))
            im.alpha_composite(ov)

        caps = self.captions_at(t)
        if caps:
            a = max(c[3] for c in caps)
            y0 = self.H - self._scrim().size[1]
            sc = Image.new("RGBA", (self.W, self._scrim().size[1]), (0, 0, 0, 255))
            sc.putalpha(self._scrim().point(lambda v: int(v * a)))
            im.alpha_composite(sc, (0, y0))
        on = self.pip_at(t)
        if on and pip is not None:
            name, alpha = on
            cam = Image.fromarray(webcam(pip[1], name, t, i)).resize(self.pip_size, Image.LANCZOS).convert("RGBA")
            x, y = self.pip_xy
            w, h = self.pip_size
            tag = name.upper()
            layer(alpha * 90 / 255, lambda d: d.rectangle([x - 2, y - 2, x + w + 1, y + h + 1], fill=(0, 0, 0, 255)))
            cam.putalpha(int(255 * alpha + 0.5))
            im.alpha_composite(cam, (x, y))
            tw = ImageDraw.Draw(im).textlength(tag, font=self.f_tag)

            def chip(d):
                d.rectangle([x + P(10), y + P(10), x + P(26) + tw, y + P(16) + self.f_tag.size + P(4)], fill=(12, 13, 15, 170))
                d.text((x + P(18), y + P(12)), tag, fill=(240, 242, 245, 255), font=self.f_tag)
            layer(alpha, chip)
        x0, yb = P(96), self.H - P(96)
        for kick, text, line2, a in caps:
            dy = int((1 - a) * P(10))
            y = yb - (self.f_sub.size + P(10) if line2 else 0)

            def cap(d, kick=kick, text=text, line2=line2, y=y, dy=dy):
                d.rectangle([x0 - P(18), y - self.f_cap.size - self.f_kick.size - P(14) + dy, x0 - P(14), y + P(6) + dy],
                            fill=(120, 214, 170, 255))
                if kick:
                    d.text((x0, y - self.f_cap.size - self.f_kick.size - P(12) + dy), kick.upper(), font=self.f_kick,
                           fill=(200, 236, 220, 230))
                d.text((x0, y - self.f_cap.size + dy), text, font=self.f_cap, fill=(247, 248, 250, 255))
                if line2:
                    d.text((x0, y + P(8) + dy), line2, font=self.f_sub, fill=(222, 226, 232, 230))
            layer(a, cap)
        stamp = self.stamp(t)
        sw = ImageDraw.Draw(im).textlength(stamp, font=self.f_clock)
        sx, sy = self.W - sw - P(40), P(30)

        def hud(d):                     # a soft dark halo keeps the stamp legible on white walls
            for ox, oy in ((1, 1), (-1, 1), (1, -1), (-1, -1), (0, 2)):
                d.text((sx + ox, sy + oy), stamp, font=self.f_clock, fill=(10, 11, 13, 120))
            d.text((sx, sy), stamp, font=self.f_clock, fill=(236, 238, 242, 255))
        layer(0.75 * k, hud)
        if self.draft and shot is not None:
            layer(220 / 255, lambda d: d.text((P(24), P(22)), "DRAFT  %s  %g mm  f/%g" % tuple(shot), font=self.f_clock,
                                              fill=(255, 210, 90, 255)))
        return np.asarray(im.convert("RGB"))

    def card_alpha(self, which, u):
        """(background, text) opacity of a card at u s: the text fades in and out, the card fades from and
        to black where it meets a fade of the run"""
        s = (self.n_title if which == "title" else self.n_end) / self.fps
        if which == "title":
            return 1 - smooth((u - (s - 0.4)) / 0.4), smooth(u / 0.7) * (1 - smooth((u - (s - 1.0)) / 0.6))
        return smooth(u / 0.4) * (1 - smooth((u - (s - 0.5)) / 0.5)), smooth((u - 0.2) / 0.8) * (1 - smooth((u - (s - 0.7)) / 0.5))

    def card(self, which, j):
        """frame j of the title or end card: text on near-black, composited at its fade"""
        from PIL import Image, ImageDraw
        c = self.cards.get(which) or {}
        bg, a = self.card_alpha(which, (j + 0.5) / self.fps)
        im = Image.new("RGBA", (self.W, self.H), (13, 14, 16, 255))
        ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
        dr = ImageDraw.Draw(ov)
        lines = [(c.get("title", ""), self.f_title, 255), (c.get("sub", ""), self.f_title2, 215)]
        lines += [(v.format(**self.vars), self.f_sub, 160) for v in c.get("notes", [])]
        y = self.H / 2 - self.f_title.size * 0.9
        for text, f, A in lines:
            if text:
                w = dr.textlength(text, font=f)
                dr.text(((self.W - w) / 2, y), text, font=f, fill=(245, 246, 248, A))
            y += f.size * (1.55 if f is self.f_title else 1.9)
        if a > 0:
            ov.putalpha(ov.getchannel("A").point(lambda v: int(v * a + 0.5)))
            im.alpha_composite(ov)
        return np.uint8(np.asarray(im.convert("RGB"), np.float32) * bg + 0.5)


_EDIT = None


def _init(args, kw):
    global _EDIT
    _EDIT = Edit(*args, **kw)


def _job(job):
    if job[0] == "card":
        return _EDIT.card(job[1], job[2]).tobytes()
    return _EDIT.compose(*job[1:]).tobytes()


class Pool:
    """Edit.compose / Edit.card in worker processes, results in submission order: put() submits and
    returns the results that are ready (a list), drain() the rest; close() stops the workers"""

    def __init__(self, args, kw, workers=8):
        import concurrent.futures as cf
        import multiprocessing as mp
        self.ex = cf.ProcessPoolExecutor(workers, mp_context=mp.get_context("spawn"), initializer=_init, initargs=(args, kw))
        self.q, self.depth = collections.deque(), 3 * workers

    def put(self, *job):
        self.q.append(self.ex.submit(_job, job))
        out = []
        while len(self.q) > self.depth:
            out.append(self.q.popleft().result())
        return out

    def drain(self):
        out = [f.result() for f in self.q]
        self.q.clear()
        self.close()
        return out

    def close(self):
        self.ex.shutdown(cancel_futures=True)
